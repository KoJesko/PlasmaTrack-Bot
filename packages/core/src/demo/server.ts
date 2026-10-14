// In-memory mock of the PlasmaTrack server API v1 (docs/contract/). Used by the
// tests, and as the "demo" backend for test Discord servers until a real test
// server exists: made-up data only, kept in memory, so it resets whenever the
// Worker restarts.
// It enforces the contract's cross-cutting rules: the two tokens, the acting
// admin, reasons, idempotency, decision transitions and cursor pagination.
// Seed data comes from the contract's examples.

import type { Decision } from '../api/schemas.ts';

export const BOT_TOKEN = 'pt_bot_test_token_not_a_secret_000001';
export const READ_TOKEN = 'pt_read_test_token_not_a_secret_00001';
export const BASE_URL = 'https://server.test';

export const ADMIN_ID = '987654321098765432';
export const PLAYER_ID = '123456789012345678';
export const OTHER_ID = '234567890123456789';

type Json = Record<string, unknown>;
type Outcome = 'valid' | 'approved' | 'pending_review' | 'invalid' | 'rejected' | 'discarded' | 'voided';

interface Player {
  user_id: string;
  discord_user_id: string;
  display_name: string;
  singleplayer_division: boolean;
  disabled: boolean;
  role: 'player' | 'admin';
  token: { token_id: string; created_at: string; last_used_at: string | null } | null;
}

interface Job {
  job_id: string;
  game: 'ets2' | 'ats';
  owner: string;
  outcome: Outcome;
  points: number | null;
  held_points: number | null;
  scored_points: number;
  before_void: Outcome | null;
  version: number;
  world_km: number;
  game_km: number;
  delivered_at: string;
}

interface Stored {
  bodyKey: string;
  status: number;
  body: Json;
}

export interface MockCall {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

const NOW = '2026-10-14T09:20:11.000Z';

/** Contract §7 transitions: action → allowed from. */
const TRANSITIONS: Record<Decision, Outcome[]> = {
  approve: ['pending_review', 'invalid', 'rejected'],
  reject: ['pending_review', 'valid', 'approved', 'invalid'],
  void: ['valid', 'approved', 'pending_review', 'invalid', 'rejected'],
  restore: ['voided'],
};

export class MockPlasmaTrackServer {
  readonly calls: MockCall[] = [];
  readonly players = new Map<string, Player>();
  readonly jobs = new Map<string, Job>();
  readonly audit: Json[] = [];
  readonly bonuses = new Map<string, Json>();
  readonly configVersions: Json[] = [];
  readonly releases: Json[] = [];
  readonly revocations = new Map<string, Json>();
  readonly operations = new Map<string, Json>();
  /** TruckersMP account IDs the tracker reported, per Discord ID. */
  readonly truckersmpAccounts = new Map<string, number[]>();
  private readonly idempotency = new Map<string, Stored>();
  private nextId = 1;
  private failures: { status: number; code: string; headers?: Record<string, string> }[] = [];
  /** Delay every response by this many ms (to test client timeouts). */
  delayMs = 0;
  /** Demo backend: any acting moderator counts as an admin (the bot has already checked their role). */
  private readonly anyActorIsAdmin: boolean;

  constructor(options: { anyActorIsAdmin?: boolean } = {}) {
    this.anyActorIsAdmin = options.anyActorIsAdmin ?? false;
    this.addPlayer(ADMIN_ID, 'Moderator', 'admin');
    this.addPlayer(PLAYER_ID, 'KoJesko');
    this.players.get(PLAYER_ID)!.token = { token_id: 'tok_4hq9x2', created_at: NOW, last_used_at: NOW };
    this.addJob({ job_id: '7K2M9QXA', game: 'ets2', owner: PLAYER_ID, outcome: 'valid', points: 7.0, scored_points: 7.0, world_km: 11.38, game_km: 125.7 });
    this.addJob({ job_id: '4QH82KDM', game: 'ats', owner: PLAYER_ID, outcome: 'discarded', points: 0, scored_points: 0, world_km: 0, game_km: 0 });
    this.addJob({ job_id: 'R3VW5T6Y', game: 'ets2', owner: PLAYER_ID, outcome: 'pending_review', points: null, held_points: 90.3, scored_points: 90.3, world_km: 145.33, game_km: 2512 });
    this.addJob({ job_id: 'H8JK2MNP', game: 'ats', owner: PLAYER_ID, outcome: 'invalid', points: 0, scored_points: 32.7, world_km: 52.4, game_km: 1048 });
  }

  addPlayer(discordId: string, name: string, role: Player['role'] = 'player'): Player {
    const p: Player = {
      user_id: `usr_${this.nextId++}`,
      discord_user_id: discordId,
      display_name: name,
      singleplayer_division: false,
      disabled: false,
      role,
      token: null,
    };
    this.players.set(discordId, p);
    return p;
  }

  addJob(j: Partial<Job> & Pick<Job, 'job_id' | 'game' | 'owner' | 'outcome'>): Job {
    const job: Job = {
      points: null,
      held_points: null,
      scored_points: 0,
      before_void: null,
      version: 1,
      world_km: 0,
      game_km: 0,
      delivered_at: '2026-10-13T21:25:03.512Z',
      ...j,
    };
    this.jobs.set(job.job_id, job);
    return job;
  }

  /** The next request fails with this status and error code (e.g. 503 unavailable). */
  failNext(status: number, code: string, headers?: Record<string, string>) {
    this.failures.push({ status, code, ...(headers ? { headers } : {}) });
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const raw = typeof init?.body === 'string' ? init.body : undefined;
    let body: unknown;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      return error(400, 'bad_request', 'malformed JSON');
    }
    this.calls.push({ method, path: url.pathname + url.search, headers, body });
    if (this.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, this.delayMs);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    }
    const failure = this.failures.shift();
    if (failure) return error(failure.status, failure.code, 'injected failure', {}, failure.headers);
    return this.handle(method, url, headers, body);
  };

  private handle(method: string, url: URL, headers: Record<string, string>, body: unknown): Response {
    if (!url.pathname.startsWith('/api/v1/')) return error(404, 'not_found', 'no such route', { resource: 'route' });
    const path = url.pathname.slice('/api/v1'.length);

    // §2 tokens
    const auth = headers['authorization'] ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (token !== BOT_TOKEN && token !== READ_TOKEN) return error(401, 'unauthorized', 'unknown token');
    if (token === READ_TOKEN && !(method === 'GET' && path.startsWith('/public/'))) {
      return error(403, 'forbidden', 'the read token can only read');
    }

    // §2 acting admin
    let actor: Player | undefined;
    if (path.startsWith('/admin/')) {
      const actorId = headers['x-plasmatrack-actor'] ?? '';
      if (this.anyActorIsAdmin && /^\d{17,20}$/.test(actorId) && !this.players.has(actorId)) this.addPlayer(actorId, 'Moderator', 'admin');
      actor = this.players.get(actorId);
      if (this.anyActorIsAdmin && actor) actor.role = 'admin';
      if (!actor || actor.role !== 'admin' || actor.disabled) return error(403, 'forbidden', 'actor is not an active admin');
    }

    const write = method !== 'GET';
    const b = (body ?? {}) as Json;
    if (write) {
      // §3 idempotency
      const key = headers['idempotency-key'];
      if (!key || !/^[\x21-\x7e]{1,128}$/.test(key)) {
        return error(400, 'validation_failed', 'Idempotency-Key required', { fields: { 'Idempotency-Key': 'required' } });
      }
      // §3 reason
      if (path.startsWith('/admin/')) {
        const reason = typeof b['reason'] === 'string' ? b['reason'].trim() : '';
        if (reason.length < 3 || reason.length > 1000) {
          return error(422, 'validation_failed', 'reason required', { fields: { reason: 'required' } });
        }
      }
      const storeKey = `${token}|${key}`;
      const bodyKey = `${method} ${path} ${JSON.stringify(body ?? null)}`;
      const stored = this.idempotency.get(storeKey);
      if (stored) {
        if (stored.bodyKey !== bodyKey) return error(409, 'idempotency_mismatch', 'key reused with a different body');
        return replay(stored);
      }
      const res = this.route(method, path, url.searchParams, b, actor);
      if (res.status < 500) {
        this.idempotency.set(storeKey, { bodyKey, status: res.status, body: res.json });
      }
      return jsonResponse(res.status, res.json);
    }
    const res = this.route(method, path, url.searchParams, b, actor);
    return jsonResponse(res.status, res.json);
  }

  private route(method: string, path: string, q: URLSearchParams, b: Json, actor?: Player): { status: number; json: Json } {
    let m: RegExpExecArray | null;
    const ok = (json: Json, status = 200) => ({ status, json });
    const err = (status: number, code: string, details: Json = {}) => ({ status, json: errorJson(code, code, details) });

    // ---- player self-service (PUBLIC_API §1)
    if ((m = /^\/players\/(\d{17,20})\/token$/.exec(path))) {
      const id = m[1]!;
      if (method === 'POST') return ok(this.issueToken(id, b, 'self', null), 201);
      if (method === 'GET') {
        const p = this.players.get(id);
        return p?.token ? ok({ ...p.token }) : err(404, 'not_found', { resource: 'token' });
      }
      if (method === 'DELETE') {
        const p = this.players.get(id);
        const revoked = p?.token?.token_id ?? null;
        if (p) p.token = null;
        this.log('self', 'token.revoke', { kind: 'user', id }, null);
        return ok({ revoked_token_id: revoked });
      }
    }
    if ((m = /^\/players\/(\d{17,20})$/.exec(path)) && method === 'PATCH') {
      const p = this.players.get(m[1]!);
      if (!p) return err(404, 'not_found', { resource: 'user' });
      if (typeof b['display_name'] === 'string') p.display_name = b['display_name'];
      return ok(this.profile(p.discord_user_id));
    }

    // ---- public reads (PUBLIC_API §2–5)
    if ((m = /^\/public\/players\/(\d{17,20})$/.exec(path))) return ok(this.profile(m[1]!));
    if ((m = /^\/public\/(ets2|ats)\/players\/(\d{17,20})\/stats$/.exec(path))) {
      return ok({ game: m[1]!, ...this.stats(m[2]!, m[1] as Job['game']) });
    }
    if ((m = /^\/public\/(ets2|ats)\/players\/(\d{17,20})\/jobs$/.exec(path))) {
      const outcomes = q.get('outcome')?.split(',');
      const items = [...this.jobs.values()]
        .filter((j) => j.game === m![1] && j.owner === m![2] && (!outcomes || outcomes.includes(j.outcome)))
        .sort((a, b2) => b2.delivered_at.localeCompare(a.delivered_at))
        .map((j) => this.summary(j));
      return this.page(items, q, true);
    }
    if ((m = /^\/public\/jobs\/([0-9A-Z]{8})$/.exec(path))) {
      const j = this.jobs.get(m[1]!);
      return j ? ok(this.detail(j)) : err(404, 'not_found', { resource: 'job' });
    }
    if ((m = /^\/public\/jobs\/([0-9A-Z]{8})\/route$/.exec(path))) {
      const j = this.jobs.get(m[1]!);
      return j ? ok(this.route_(j, false)) : err(404, 'not_found', { resource: 'job' });
    }
    if ((m = /^\/public\/(ets2|ats)\/leaderboard$/.exec(path))) {
      const game = m[1] as Job['game'];
      const division = q.get('division') ?? 'all';
      const rows = [...this.players.values()]
        .filter((p) => !p.disabled && (division !== 'singleplayer' || p.singleplayer_division))
        .map((p) => ({ p, s: this.stats(p.discord_user_id, game) }))
        .filter((r) => r.s.job_count > 0)
        .sort((a, b2) => b2.s.points - a.s.points);
      const items = rows.map((r, i) => ({
        rank: i + 1,
        user_id: r.p.user_id,
        discord_user_id: r.p.discord_user_id,
        display_name: r.p.display_name,
        points: r.s.points,
        job_count: r.s.job_count,
        world_km: r.s.world_km,
        world_mi: r.s.world_mi,
        game_km: r.s.game_km,
        game_mi: r.s.game_mi,
      }));
      const pg = this.page(items, q, true);
      return ok({
        game,
        period: q.get('period') ?? 'all',
        at: q.get('at'),
        division,
        period_start: null,
        period_end: null,
        generated_at: NOW,
        ...pg.json,
      });
    }

    // ---- admin (ADMIN_API)
    if (path === '/admin/review-queue') {
      const outcomes = q.get('outcome')?.split(',') ?? ['pending_review', 'invalid'];
      const items = [...this.jobs.values()]
        .filter((j) => outcomes.includes(j.outcome) && (!q.get('game') || j.game === q.get('game')))
        .map((j) => ({
          ...this.summary(j),
          player: this.ref(j.owner),
          age_s: 43920,
          reasons: j.outcome === 'invalid' ? [{ code: 'overspeed_invalid', details: {} }] : [{ code: 'late_start', text: 'Tracking started after the job was accepted.', details: {} }],
        }));
      return this.page(items, q, true);
    }
    if (path === '/admin/review-queue/count') {
      const jobs = [...this.jobs.values()].filter((j) => !q.get('game') || j.game === q.get('game'));
      return ok({
        pending_review: jobs.filter((j) => j.outcome === 'pending_review').length,
        invalid: jobs.filter((j) => j.outcome === 'invalid').length,
        by_reason: { late_start: jobs.filter((j) => j.outcome === 'pending_review').length },
      });
    }
    if (path === '/admin/truckersmp/flags') return this.page([], q, false);
    if ((m = /^\/admin\/jobs\/([0-9A-Z]{8})$/.exec(path))) {
      const j = this.jobs.get(m[1]!);
      if (!j) return err(404, 'not_found', { resource: 'job' });
      return ok({ ...this.detail(j), reasons: [], etag: etag(j), state: 'delivered', start_kind: 'tracked', timeline: [] });
    }
    if ((m = /^\/admin\/jobs\/([0-9A-Z]{8})\/series$/.exec(path))) {
      const j = this.jobs.get(m[1]!);
      if (!j) return err(404, 'not_found', { resource: 'job' });
      const max = Math.min(4000, Number(q.get('max_points') ?? 1000));
      if (!Number.isInteger(max) || max < 1) return err(400, 'bad_request', { max_points: 'invalid' });
      return ok({
        job_id: j.job_id,
        game: j.game,
        bucket_s: 1.15,
        penalty_over_mph: 100,
        invalid_over_mph: 150,
        points: [{ t: '2026-10-13T21:05:47.000Z', speed_mph_min: 0, speed_mph_max: 3.1, fuel_l_min: 612.4, fuel_l_max: 612.5, reverted: false }],
        windows: [{ kind: 'train', from: '2026-10-13T21:20:16.000Z', to: '2026-10-13T21:20:24.000Z' }],
        markers: [],
      });
    }
    if ((m = /^\/admin\/jobs\/([0-9A-Z]{8})\/route$/.exec(path))) {
      const j = this.jobs.get(m[1]!);
      return j ? ok(this.route_(j, true)) : err(404, 'not_found', { resource: 'job' });
    }
    if ((m = /^\/admin\/jobs\/([0-9A-Z]{8})\/trace$/.exec(path))) {
      const j = this.jobs.get(m[1]!);
      if (!j) return err(404, 'not_found', { resource: 'job' });
      this.log(actor!.discord_user_id, 'trace.download', { kind: 'job', id: j.job_id }, null);
      return ok({ url: `${BASE_URL}/dl/trace/${j.job_id}?exp=1&sig=x`, expires_at: NOW, size_bytes: 1846089, format: 'jsonl+gzip', frames: 15800 });
    }
    if ((m = /^\/admin\/jobs\/([0-9A-Z]{8})\/(approve|reject|void|restore)$/.exec(path)) && method === 'POST') {
      const j = this.jobs.get(m[1]!);
      if (!j) return err(404, 'not_found', { resource: 'job' });
      const action = m[2] as Decision;
      if (typeof b['expected_etag'] === 'string' && b['expected_etag'] !== etag(j)) {
        return err(409, 'conflict', { current_etag: etag(j) });
      }
      if (!TRANSITIONS[action].includes(j.outcome)) return err(409, 'invalid_transition', { from: j.outcome, action });
      const before = j.outcome;
      if (action === 'approve') this.setOutcome(j, 'approved');
      else if (action === 'reject') this.setOutcome(j, 'rejected');
      else if (action === 'void') {
        j.before_void = j.outcome;
        this.setOutcome(j, 'voided');
      } else this.setOutcome(j, j.before_void ?? 'valid');
      this.log(actor!.discord_user_id, `job.${action}`, { kind: 'job', id: j.job_id }, String(b['reason']), { outcome: before }, { outcome: j.outcome, points: j.points });
      return ok({ job_id: j.job_id, outcome: j.outcome, points: j.points, held_points: j.held_points, etag: etag(j) });
    }
    if ((m = /^\/admin\/jobs\/([0-9A-Z]{8})\/recalculate$/.exec(path)) && method === 'POST') {
      const j = this.jobs.get(m[1]!);
      if (!j) return err(404, 'not_found', { resource: 'job' });
      const snap = { outcome: j.outcome, points: j.points, held_points: j.held_points };
      j.version++;
      return ok({ job_id: j.job_id, before: snap, after: snap, etag: etag(j) });
    }
    if (path === '/admin/recalculations' && method === 'POST') {
      const game = b['game'] as string | undefined;
      const affected = [...this.jobs.values()].filter((j) => !game || j.game === game).length;
      if (b['dry_run'] === true) return ok({ affected_jobs: affected, game: game ?? null });
      const running = [...this.operations.values()].find((o) => o['status'] === 'running' || o['status'] === 'queued');
      if (running) return err(409, 'conflict', { operation_id: running['operation_id'] });
      const id = `op_${this.nextId++}`;
      this.operations.set(id, { operation_id: id, kind: 'recalculation', status: 'running', progress: { done: 0, total: affected }, started_at: NOW, finished_at: null, summary: null });
      return ok({ operation_id: id, affected_jobs: affected }, 202);
    }
    if ((m = /^\/admin\/operations\/(op_\w+)$/.exec(path))) {
      const op = this.operations.get(m[1]!);
      return op ? ok(op) : err(404, 'not_found', { resource: 'operation' });
    }
    if (path === '/admin/bonuses') {
      if (method === 'GET') {
        const items = [...this.bonuses.values()].filter((x) => (!q.get('game') || x['game'] === q.get('game')) && (!q.get('status') || x['status'] === q.get('status')));
        return this.page(items, q, true);
      }
      if (method === 'POST') {
        const id = `bon_${this.nextId++}`;
        const { reason: _r, ...fields } = b;
        const bonus = { bonus_id: id, ...fields, status: 'scheduled', created_at: NOW, updated_at: NOW };
        this.bonuses.set(id, bonus);
        this.log(actor!.discord_user_id, 'bonus.create', { kind: 'bonus', id }, String(b['reason']));
        return ok(bonus, 201);
      }
    }
    if ((m = /^\/admin\/bonuses\/(bon_\w+)$/.exec(path))) {
      const bonus = this.bonuses.get(m[1]!);
      if (!bonus) return err(404, 'not_found', { resource: 'bonus' });
      if (method === 'GET') return ok(bonus);
      if (method === 'PATCH') {
        const { reason: _r, ...fields } = b;
        Object.assign(bonus, fields, { updated_at: NOW });
        return ok(bonus);
      }
      if (method === 'DELETE') {
        bonus['status'] = 'archived';
        return ok(bonus);
      }
    }
    if ((m = /^\/admin\/players\/(\d{17,20})$/.exec(path))) {
      const id = m[1]!;
      if (method === 'GET') {
        const p = this.players.get(id);
        if (!p) return ok({ linked: false, discord_user_id: id });
        return ok({ ...this.profile(id), role: p.role, created_at: NOW, token: p.token, truckersmp_flags: [] });
      }
      if (method === 'PATCH') {
        const p = this.players.get(id);
        if (!p) return err(404, 'not_found', { resource: 'user' });
        for (const k of ['singleplayer_division', 'disabled', 'display_name'] as const) {
          if (k in b) (p as unknown as Json)[k] = b[k];
        }
        this.log(actor!.discord_user_id, 'player.update', { kind: 'user', id }, String(b['reason']));
        return ok({ ...this.profile(id), role: p.role, token: p.token });
      }
    }
    if ((m = /^\/admin\/players\/(\d{17,20})\/token$/.exec(path))) {
      const id = m[1]!;
      if (method === 'POST') return ok(this.issueToken(id, b, actor!.discord_user_id, String(b['reason'])), 201);
      if (method === 'DELETE') {
        const p = this.players.get(id);
        const revoked = p?.token?.token_id ?? null;
        if (p) p.token = null;
        this.log(actor!.discord_user_id, 'token.revoke', { kind: 'user', id }, String(b['reason']));
        return ok({ revoked_token_id: revoked });
      }
    }
    if (path === '/admin/config-versions') {
      if (method === 'GET') return this.page([...this.configVersions].reverse(), q, true);
      const toml = String(b['toml'] ?? '');
      if (toml.length > 256 * 1024) return err(413, 'payload_too_large', { max_bytes: 256 * 1024 });
      if (!toml.includes('=')) return err(422, 'validation_failed', { errors: ['not a valid plasmatrack.toml'] });
      const current = b['make_current'] === true;
      if (current) for (const v of this.configVersions) v['current'] = false;
      const v = { version_id: `cfg_${this.configVersions.length + 1}`, integrity_hash: 'f00d', current, created_at: NOW };
      this.configVersions.push(v);
      return ok(v, 201);
    }
    if ((m = /^\/admin\/config-versions\/(cfg_\w+)\/make-current$/.exec(path)) && method === 'POST') {
      const v = this.configVersions.find((x) => x['version_id'] === m![1]);
      if (!v) return err(404, 'not_found', { resource: 'config_version' });
      for (const x of this.configVersions) x['current'] = x === v;
      return ok(v);
    }
    if (path === '/admin/releases') {
      if (method === 'GET') return this.page(this.releases, q, true);
      const { reason: _r, ...fields } = b;
      const r = { release_id: `rel_${String(b['release_version']).replace(/\./g, '_')}`, ...fields, created_at: NOW };
      this.releases.push(r);
      return ok(r, 201);
    }
    if (path === '/admin/revocations') {
      if (method === 'GET') {
        const items = [...this.revocations.values()].filter((r) => !q.get('status') || r['status'] === q.get('status'));
        return this.page(items, q, false);
      }
      const id = `rev_${this.nextId++}`;
      const announced = Date.parse(NOW);
      const r = {
        revocation_id: id,
        target: b['target'],
        announced_at: NOW,
        effective_at: new Date(announced + 21 * 24 * 3600_000).toISOString(),
        recipients_count: 2,
        status: 'scheduled',
      };
      this.revocations.set(id, r);
      return ok(r, 201);
    }
    if ((m = /^\/admin\/revocations\/(rev_\w+)\/cancel$/.exec(path)) && method === 'POST') {
      const r = this.revocations.get(m[1]!);
      if (!r) return err(404, 'not_found', { resource: 'revocation' });
      if (r['status'] !== 'scheduled') return err(409, 'invalid_transition', { from: r['status'], action: 'cancel' });
      r['status'] = 'cancelled';
      return ok(r);
    }
    if (path === '/admin/admins') {
      const admins = [...this.players.values()].filter((p) => p.role === 'admin');
      if (method === 'GET') return this.page(admins.map((p) => ({ discord_user_id: p.discord_user_id, display_name: p.display_name })), q, true);
      const id = String(b['discord_user_id']);
      const p = this.players.get(id) ?? this.addPlayer(id, 'New admin');
      p.role = 'admin';
      return ok({ discord_user_id: id, display_name: p.display_name }, 201);
    }
    if ((m = /^\/admin\/admins\/(\d{17,20})$/.exec(path)) && method === 'DELETE') {
      const admins = [...this.players.values()].filter((p) => p.role === 'admin');
      const p = this.players.get(m[1]!);
      if (!p || p.role !== 'admin') return err(404, 'not_found', { resource: 'admin' });
      if (admins.length === 1) return err(409, 'invalid_transition', { from: 'last_admin', action: 'remove' });
      p.role = 'player';
      return ok({ discord_user_id: p.discord_user_id });
    }
    if (path === '/admin/audit') {
      const items = [...this.audit].reverse().filter((a) => !q.get('job_id') || (a['target'] as Json | undefined)?.['id'] === q.get('job_id'));
      return this.page(items, q, false);
    }

    return err(404, 'not_found', { resource: 'route' });
  }

  // ---- helpers

  private issueToken(discordId: string, b: Json, actor: string, reason: string | null): Json {
    let p = this.players.get(discordId);
    const created = !p;
    if (!p) p = this.addPlayer(discordId, typeof b['display_name'] === 'string' ? b['display_name'] : 'Player');
    const revoked = p.token?.token_id ?? null;
    const tokenId = `tok_${this.nextId++}`;
    p.token = { token_id: tokenId, created_at: NOW, last_used_at: null };
    this.log(actor, 'token.issue', { kind: 'user', id: discordId }, reason);
    return {
      user: { user_id: p.user_id, discord_user_id: discordId, display_name: p.display_name, created },
      token: { token_id: tokenId, token: `pt_live_mock_${tokenId}_plaintext`, created_at: NOW, revoked_token_id: revoked },
    };
  }

  private setOutcome(j: Job, outcome: Outcome) {
    j.outcome = outcome;
    const counts = outcome === 'valid' || outcome === 'approved';
    j.points = counts ? j.scored_points : outcome === 'pending_review' ? null : 0;
    j.held_points = outcome === 'pending_review' ? j.scored_points : null;
    j.version++;
  }

  private log(actor: string, action: string, target: Json, reason: string | null, before?: Json, after?: Json) {
    this.audit.push({
      audit_id: `aud_${this.nextId++}`,
      at: NOW,
      actor: actor === 'self' ? 'self' : { discord_user_id: actor, display_name: this.players.get(actor)?.display_name },
      action,
      target,
      reason,
      ...(before ? { before } : {}),
      ...(after ? { after } : {}),
    });
  }

  private ref(discordId: string): Json {
    const p = this.players.get(discordId)!;
    return { user_id: p.user_id, discord_user_id: p.discord_user_id, display_name: p.display_name };
  }

  private profile(discordId: string): Json {
    const p = this.players.get(discordId);
    if (!p) return { linked: false, discord_user_id: discordId };
    return {
      linked: true,
      ...this.ref(discordId),
      singleplayer_division: p.singleplayer_division,
      disabled: p.disabled,
      truckersmp_accounts: (this.truckersmpAccounts.get(discordId) ?? []).map((id) => ({
        account_id: id,
        profile_url: `https://truckersmp.com/user/${id}`,
        first_seen_at: NOW,
        last_seen_at: NOW,
        job_count: 1,
      })),
      stats: { ets2: this.stats(discordId, 'ets2'), ats: this.stats(discordId, 'ats') },
    };
  }

  private stats(discordId: string, game: Job['game']) {
    const jobs = [...this.jobs.values()].filter((j) => j.owner === discordId && j.game === game);
    const counted = jobs.filter((j) => j.outcome === 'valid' || j.outcome === 'approved');
    const sum = (f: (j: Job) => number) => Math.round(counted.reduce((n, j) => n + f(j), 0) * 100) / 100;
    return {
      points: sum((j) => j.points ?? 0),
      job_count: counted.length,
      world_km: sum((j) => j.world_km),
      world_mi: sum((j) => j.world_km * 0.621371),
      game_km: sum((j) => j.game_km),
      game_mi: sum((j) => j.game_km * 0.621371),
      pending_review_count: jobs.filter((j) => j.outcome === 'pending_review').length,
    };
  }

  private summary(j: Job): Json {
    return {
      job_id: j.job_id,
      game: j.game,
      outcome: j.outcome,
      points: j.points,
      held_points: j.held_points,
      world_km: j.world_km,
      world_mi: Math.round(j.world_km * 0.621371 * 100) / 100,
      game_km: j.game_km,
      game_mi: Math.round(j.game_km * 0.621371 * 100) / 100,
      cargo: { id: 'med_vaccine', name: 'Vaccines' },
      source: { city_id: 'dover', city_name: 'Dover', company_id: 'euroacres', company_name: 'EuroAcres' },
      destination: { city_id: 'calais', city_name: 'Calais', company_id: 'lkwlog', company_name: 'LKW Log' },
      market: 'cargo_market',
      delivered_at: j.delivered_at,
      reported_delivered_at: '2026-10-13T21:25:00.070Z',
      multiplayer: { kind: 'singleplayer', truckersmp: null },
      some_future_field: { ignored: true },
    };
  }

  private detail(j: Job): Json {
    const zero = { world_km: 0, world_mi: 0, game_km: 0, game_mi: 0 };
    return {
      ...this.summary(j),
      player: this.ref(j.owner),
      planned_distance_km: 62,
      speed_penalty_applied: false,
      bonus: null,
      distance_by_scale_class: { city: { world_km: 2.81, world_mi: 1.75, game_km: 8.43, game_mi: 5.24 }, road: { world_km: 8.57, world_mi: 5.33, game_km: 117.27, game_mi: 72.87 }, one_to_one: zero, nonstandard: zero, unknown: zero },
      public_notes: j.outcome === 'pending_review' ? [{ code: 'under_review', text: 'A moderator will check this job.' }] : [],
    };
  }

  private route_(j: Job, admin: boolean): Json {
    const features: Json[] = [
      feature(0, 'driving', 'city', false, [[1.3133, 51.1268], [1.3141, 51.1262]]),
      feature(1, 'driving', 'road', true, [[1.3141, 51.1262], [1.25, 51.12], [1.19, 51.1]]),
      feature(2, 'train', 'unknown', false, [[1.1876, 51.0959], [1.8579, 50.9513]]),
      feature(3, 'driving', 'future_scale_kind', true, [[1.8579, 50.9513], [1.86, 50.95]]),
    ];
    if (admin) {
      for (const f of features) (f['properties'] as Json)['status'] = 'kept';
      features.push({ ...feature(4, 'driving', 'road', true, [[1.2, 51.11], [1.21, 51.115]]), properties: { index: 4, segment: 'driving', scale_class: 'road', counted: true, status: 'reverted' } });
    }
    return {
      type: 'FeatureCollection',
      bbox: [1.17, 50.95, 1.86, 51.13],
      properties: { job_id: j.job_id, game: j.game, vertex_count: 10, max_vertices: 5000, simplification_tolerance_world_m: 5.0, includes_reverted: admin },
      features,
    };
  }

  private page(items: unknown[], q: URLSearchParams, withTotal: boolean): { status: number; json: Json } {
    const limit = Math.min(100, Math.max(1, Number(q.get('limit') ?? 20) || 20));
    let offset = 0;
    const cursor = q.get('cursor');
    if (cursor) {
      const m = /^o(\d+)$/.exec(atob(cursor.replace(/-/g, '+').replace(/_/g, '/')));
      if (!m) return { status: 400, json: errorJson('bad_request', 'bad cursor', { cursor: 'expired' }) };
      offset = Number(m[1]);
    }
    const slice = items.slice(offset, offset + limit);
    const next = offset + limit < items.length ? btoa(`o${offset + limit}`).replace(/=+$/, '') : null;
    return { status: 200, json: { items: slice, next_cursor: next, ...(withTotal ? { total: items.length } : {}) } };
  }
}

function feature(index: number, segment: string, scale_class: string, counted: boolean, coordinates: number[][]): Json {
  return {
    type: 'Feature',
    geometry: { type: 'LineString', coordinates },
    properties: { index, segment, local_scale: scale_class === 'city' ? 3 : null, scale_class, counted, start_at: NOW, end_at: NOW, world_km: 1, game_km: 3 },
  };
}

function etag(j: Job): string {
  return `"j${j.job_id}-v${j.version}"`;
}

function errorJson(code: string, message: string, details: Json = {}): Json {
  return { error: { code, message, details } };
}

function jsonResponse(status: number, json: Json, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function error(status: number, code: string, message: string, details: Json = {}, headers: Record<string, string> = {}): Response {
  return jsonResponse(status, errorJson(code, message, details), headers);
}

function replay(stored: Stored): Response {
  // A replayed token issue never shows the plaintext again (PUBLIC_API §1).
  const body = structuredClone(stored.body);
  const token = body['token'] as Json | undefined;
  if (token && typeof token['token'] === 'string') {
    token['token'] = null;
    return jsonResponse(200, { ...body, replayed: true });
  }
  return jsonResponse(stored.status, body);
}
