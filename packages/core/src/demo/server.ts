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
  /** Tracked jobs' fuel (L), cargo damage (%) and income (server 69fcfe9); null when unknown. */
  fuel_l?: number | null;
  damage_pct?: number | null;
  income?: number | null;
  /** Manual jobs (PUBLIC_API §6): the submitted body, its images and moderator edits. */
  origin?: 'tracked' | 'manual';
  submission?: Json;
  evidence?: { id: string; role: string; section?: number }[];
  hide_map?: boolean;
  overrides?: Json;
}

interface Evidence {
  owner: string;
  bytes: Uint8Array;
  content_type: string;
  used: boolean;
}

const KM_PER_MI = 1.609344;
const MAX_EVIDENCE_BYTES = 5 * 1024 * 1024;
/** PATCH /admin/jobs fields (ADMIN_API §14). */
const EDIT_FIELDS = new Set([
  'unit', 'fuel_unit', 'start_city', 'start_company', 'end_city', 'end_company', 'cargo_name', 'distance', 'fuel_used', 'damage',
  'profit', 'started_at', 'ended_at', 'truck', 'truck_model', 'mod_names', 'map_scale', 'uk', 'adjusted_scales', 'bonus_id',
]);
const round2 = (n: number) => Math.round(n * 100) / 100;
const MAX_SECTIONS = 5;
const CITY_RULE_TEXT = 'a city-scale section counts only from 3 mi in game (1 mi real)';

/** PUBLIC_API §6: each section complete, at most 5, and the city-scale minimum. */
function checkSections(list: Json[], unit: unknown, fields: Record<string, string>, needEvidence: boolean) {
  if (list.length > MAX_SECTIONS) fields['adjusted_scales'] = 'at most 5 sections';
  list.forEach((s, i) => {
    for (const k of ['entry_city', 'exit_city', ...(needEvidence ? ['evidence'] : [])]) if (typeof s[k] !== 'string' || !s[k]) fields[`adjusted_scales[${i}].${k}`] = 'required';
    for (const k of ['distance', 'scale']) if (typeof s[k] !== 'number' || !((s[k] as number) > 0)) fields[`adjusted_scales[${i}].${k}`] = 'a number above 0';
    const minimum = unit === 'mi' ? 3 : 3 * KM_PER_MI;
    if (s['scale'] === 3 && typeof s['distance'] === 'number' && s['distance'] < minimum) fields[`adjusted_scales[${i}].distance`] = CITY_RULE_TEXT;
  });
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
  /** Uploaded evidence images (PUBLIC_API §6). */
  readonly evidence = new Map<string, Evidence>();
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
    this.addJob({ job_id: '7K2M9QXA', game: 'ets2', owner: PLAYER_ID, outcome: 'valid', points: 7.0, scored_points: 7.0, world_km: 11.38, game_km: 125.7, fuel_l: 41.2, damage_pct: 1.5, income: 4210 });
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
    // Signed evidence links need no token (PUBLIC_API §6).
    const dl = /^\/dl\/evidence\/(evd_\w+)$/.exec(url.pathname);
    if (dl && method === 'GET') {
      const e = this.evidence.get(dl[1]!);
      return e ? new Response(e.bytes.slice(), { headers: { 'Content-Type': e.content_type } }) : error(404, 'not_found', 'no such image');
    }
    const raw = typeof init?.body === 'string' ? init.body : undefined;
    // Evidence uploads are raw bytes, not JSON.
    const bytes: Uint8Array | undefined = init?.body instanceof Uint8Array ? init.body : init?.body instanceof ArrayBuffer ? new Uint8Array(init.body) : undefined;
    let body: unknown;
    try {
      body = raw ? JSON.parse(raw) : bytes ? { raw_size: bytes.length, raw_sum: bytes.reduce((n: number, x: number) => (n + x) % 65521, 0) } : undefined;
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
    return this.handle(method, url, headers, body, bytes);
  };

  private handle(method: string, url: URL, headers: Record<string, string>, body: unknown, bytes?: Uint8Array): Response {
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
      const res = this.route(method, path, url.searchParams, b, actor, bytes ? { bytes, contentType: headers['content-type'] ?? '' } : undefined);
      if (res.status < 500) {
        this.idempotency.set(storeKey, { bodyKey, status: res.status, body: res.json });
      }
      return jsonResponse(res.status, res.json);
    }
    const res = this.route(method, path, url.searchParams, b, actor);
    return jsonResponse(res.status, res.json);
  }

  private route(
    method: string,
    path: string,
    q: URLSearchParams,
    b: Json,
    actor?: Player,
    raw?: { bytes: Uint8Array; contentType: string },
  ): { status: number; json: Json } {
    let m: RegExpExecArray | null;
    const ok = (json: Json, status = 200) => ({ status, json });
    const err = (status: number, code: string, details: Json = {}) => ({ status, json: errorJson(code, code, details) });

    // ---- manual submissions (PUBLIC_API §6)
    if ((m = /^\/players\/(\d{17,20})\/evidence$/.exec(path)) && method === 'POST') {
      if (!raw) return err(400, 'bad_request', { body: 'image bytes expected' });
      if (raw.bytes.length > MAX_EVIDENCE_BYTES) return err(413, 'payload_too_large', { max_bytes: MAX_EVIDENCE_BYTES });
      const p = this.players.get(m[1]!) ?? this.addPlayer(m[1]!, 'Player');
      if (p.disabled) return err(403, 'forbidden', { reason: 'disabled' });
      const id = `evd_${this.nextId++}`;
      this.evidence.set(id, { owner: p.discord_user_id, bytes: raw.bytes, content_type: raw.contentType, used: false });
      return ok({ evidence_id: id, content_type: raw.contentType, size_bytes: raw.bytes.length, sha256: '0'.repeat(64), expires_at: NOW }, 201);
    }
    if ((m = /^\/players\/(\d{17,20})\/manual-jobs$/.exec(path)) && method === 'POST') {
      return this.submitManual(m[1]!, b);
    }
    if ((m = /^\/players\/(\d{17,20})\/jobs\/([0-9A-Z]{8})\/evidence$/.exec(path)) && method === 'GET') {
      const j = this.jobs.get(m[2]!);
      if (!j || j.owner !== m[1]) return err(404, 'not_found', { resource: 'job' });
      return ok({ job_id: j.job_id, items: (j.evidence ?? []).map((e) => this.evidenceItem(e)) });
    }

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
    if ((m = /^\/public\/players\/(\d{17,20})\/jobs$/.exec(path))) {
      const outcomes = q.get('outcome')?.split(',');
      const items = [...this.jobs.values()]
        .filter((j) => j.owner === m![1] && (!outcomes || outcomes.includes(j.outcome)))
        .sort((a, b2) => b2.delivered_at.localeCompare(a.delivered_at))
        .map((j) => this.summary(j));
      return this.page(items, q, true);
    }
    if ((m = /^\/public\/jobs\/([0-9A-Z]{8})$/.exec(path))) {
      const j = this.jobs.get(m[1]!);
      return j ? ok(this.detail(j)) : err(404, 'not_found', { resource: 'job' });
    }
    if ((m = /^\/public\/(ets2|ats)\/players\/(\d{17,20})\/history$/.exec(path))) {
      const h = this.history(m[1] as Job['game'], m[2]!, q.get('bucket') ?? 'week');
      return h ? ok(h) : err(400, 'bad_request', { bucket: 'day, week or month' });
    }
    if ((m = /^\/public\/jobs\/([0-9A-Z]{8})\/series$/.exec(path))) {
      const j = this.jobs.get(m[1]!);
      const shown = j && j.origin !== 'manual' && (j.outcome === 'valid' || j.outcome === 'approved');
      return shown ? ok(this.series(j, true)) : err(404, 'not_found', { resource: 'job' });
    }
    if ((m = /^\/public\/jobs\/([0-9A-Z]{8})\/route$/.exec(path))) {
      const j = this.jobs.get(m[1]!);
      return j && j.origin !== 'manual' ? ok(this.route_(j, false)) : err(404, 'not_found', { resource: 'job' });
    }
    if ((m = /^\/public\/(ets2|ats)\/leaderboard$/.exec(path))) {
      const game = m[1] as Job['game'];
      const division = q.get('division') ?? 'all';
      const sort = q.get('sort') ?? 'points';
      const field: Record<string, string> = { points: 'points', distance: 'world_km', game_distance: 'game_km', fuel: 'fuel_used_l', income: 'income', damage: 'damage_pct_avg' };
      if (!field[sort]) return err(400, 'bad_request', { sort: Object.keys(field).join(', ') });
      const order = q.get('order') ?? (sort === 'damage' ? 'asc' : 'desc');
      if (order !== 'asc' && order !== 'desc') return err(400, 'bad_request', { order: 'asc or desc' });
      const key = field[sort]!;
      const rows = [...this.players.values()]
        .filter((p) => !p.disabled && (division !== 'singleplayer' || p.singleplayer_division))
        .map((p) => ({ p, t: this.totals([...this.jobs.values()].filter((j) => j.owner === p.discord_user_id && j.game === game)) }))
        .filter((r) => (r.t['job_count'] as number) > 0)
        .sort((a, b2) => {
          const x = a.t[key] as number | null;
          const y = b2.t[key] as number | null;
          // Players without a value rank last.
          if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
          return order === 'asc' ? x - y : y - x;
        });
      const items = rows.map((r, i) => ({
        rank: i + 1,
        user_id: r.p.user_id,
        discord_user_id: r.p.discord_user_id,
        display_name: r.p.display_name,
        ...r.t,
      }));
      const pg = this.page(items, q, true);
      return ok({
        game,
        period: q.get('period') ?? 'all',
        at: q.get('at'),
        division,
        sort,
        order,
        currency: game === 'ets2' ? 'EUR' : 'USD',
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
          reasons: this.reasons(j),
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
      if (method === 'PATCH') {
        const problem = this.applyEdit(j, b, actor!.discord_user_id, String(b['reason']));
        if (problem) return err(422, 'validation_failed', { fields: problem });
        return ok({ job_id: j.job_id, outcome: j.outcome, points: j.points, held_points: j.held_points, overrides: j.overrides ?? {}, etag: etag(j) });
      }
      return ok(this.adminDetail(j));
    }
    if ((m = /^\/admin\/jobs\/([0-9A-Z]{8})\/series$/.exec(path))) {
      const j = this.jobs.get(m[1]!);
      if (!j || j.origin === 'manual') return err(404, 'not_found', { resource: 'job' });
      const max = Math.min(4000, Number(q.get('max_points') ?? 1000));
      if (!Number.isInteger(max) || max < 1) return err(400, 'bad_request', { max_points: 'invalid' });
      return ok(this.series(j, false));
    }
    if ((m = /^\/admin\/jobs\/([0-9A-Z]{8})\/route$/.exec(path))) {
      const j = this.jobs.get(m[1]!);
      return j && j.origin !== 'manual' ? ok(this.route_(j, true)) : err(404, 'not_found', { resource: 'job' });
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
      if (action !== 'approve' && (b['hide_map'] !== undefined || b['corrections'] !== undefined)) {
        return err(422, 'validation_failed', { fields: { [b['hide_map'] !== undefined ? 'hide_map' : 'corrections']: 'only on approve' } });
      }
      if (b['corrections'] !== undefined) {
        const problem = this.applyEdit(j, b['corrections'] as Json, actor!.discord_user_id, String(b['reason']));
        if (problem) return err(422, 'validation_failed', { fields: Object.fromEntries(Object.entries(problem).map(([k, v]) => [`corrections.${k}`, v])) });
      }
      if (typeof b['hide_map'] === 'boolean') j.hide_map = b['hide_map'];
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

  private submitManual(discordId: string, b: Json): { status: number; json: Json } {
    const p = this.players.get(discordId) ?? this.addPlayer(discordId, 'Player');
    if (p.disabled) return { status: 403, json: errorJson('forbidden', 'player disabled', { reason: 'disabled' }) };
    const fields: Record<string, string> = {};
    const str = (k: string) => typeof b[k] === 'string' && (b[k] as string).trim() !== '';
    const num = (k: string) => typeof b[k] === 'number' && Number.isFinite(b[k]);
    if (b['game'] !== 'ets2' && b['game'] !== 'ats') fields['game'] = 'ets2 or ats';
    if (b['unit'] !== 'mi' && b['unit'] !== 'km') fields['unit'] = 'mi or km';
    if (!['l', 'us_gal', 'uk_gal'].includes(String(b['fuel_unit']))) fields['fuel_unit'] = 'l, us_gal or uk_gal';
    for (const k of ['start_city', 'start_company', 'end_city', 'end_company', 'cargo_name', 'truck', 'started_at', 'ended_at']) if (!str(k)) fields[k] = 'required';
    for (const k of ['distance', 'fuel_used', 'damage', 'profit']) if (!num(k)) fields[k] = 'a number';
    if (num('damage') && ((b['damage'] as number) < 0 || (b['damage'] as number) > 100)) fields['damage'] = 'a number from 0 to 100';
    if ('bonus_id' in b) fields['bonus_id'] = 'a player never picks a bonus';
    const uk = b['uk'] as Json | undefined;
    if (uk && b['game'] !== 'ets2') fields['uk'] = 'ETS2 only';
    const images: { id: string; role: string; field: string; section?: number }[] = [];
    const evidence = Array.isArray(b['evidence']) ? (b['evidence'] as unknown[]) : [];
    if (evidence.length < 1 || evidence.length > 5) fields['evidence'] = '1 to 5 images';
    evidence.forEach((id, i) => images.push({ id: String(id), role: 'main', field: `evidence[${i}]` }));
    if (b['custom_map'] !== undefined) images.push({ id: String(b['custom_map']), role: 'custom_map', field: 'custom_map' });
    if (uk?.['route_evidence'] !== undefined) images.push({ id: String(uk['route_evidence']), role: 'uk_route', field: 'uk.route_evidence' });
    if ('adjusted_scale' in b) fields['adjusted_scale'] = 'replaced by adjusted_scales, a list';
    const sections = Array.isArray(b['adjusted_scales']) ? (b['adjusted_scales'] as Json[]) : [];
    checkSections(sections, b['unit'], fields, true);
    const parts = sections.reduce((sum, s) => sum + (Number(s['distance']) || 0), 0) + (uk ? Number(uk['distance']) || 0 : 0);
    if (num('distance') && parts > (b['distance'] as number)) fields['adjusted_scales'] = 'the UK stretch and the sections are part of distance and cannot exceed it';
    sections.forEach((s, i) => {
      if (s['evidence'] !== undefined) images.push({ id: String(s['evidence']), role: 'adjusted_scale', field: `adjusted_scales[${i}].evidence`, section: i });
    });
    for (const img of images) {
      const e = this.evidence.get(img.id);
      if (!e || e.owner !== discordId || e.used) fields[img.field] = 'not an unused image of this player';
    }
    if (Object.keys(fields).length > 0) return { status: 422, json: errorJson('validation_failed', 'Some fields are invalid.', { fields }) };

    for (const img of images) this.evidence.get(img.id)!.used = true;
    const jobId = `MAN${String(this.nextId++).padStart(5, '0')}`;
    const job = this.addJob({
      job_id: jobId,
      game: b['game'] as Job['game'],
      owner: discordId,
      outcome: 'pending_review',
      delivered_at: NOW,
      origin: 'manual',
      submission: structuredClone(b),
      evidence: images.map((i) => ({ id: i.id, role: i.role, ...(i.section !== undefined ? { section: i.section } : {}) })),
      hide_map: false,
      overrides: {},
    });
    this.rescoreManual(job);
    job.held_points = job.scored_points;
    this.log('self', 'job.submit', { kind: 'job', id: jobId }, null, {}, { game: job.game, evidence: images.length });
    return { status: 201, json: this.detail(job) };
  }

  /** World distance the manual way (PUBLIC_API §6): (D − UK − Σsections) ÷ scale + UK ÷ 15 + Σ(section ÷ its scale). */
  private rescoreManual(j: Job) {
    const s = this.sheetInput(j);
    const k = s['unit'] === 'mi' ? KM_PER_MI : 1;
    const d = Number(s['distance']) * k;
    const uk = s['uk'] ? Number((s['uk'] as Json)['distance'] ?? 0) * k : 0;
    const sections = (s['adjusted_scales'] as Json[] | null | undefined) ?? [];
    const adjKm = sections.reduce((sum, a) => sum + Number(a['distance'] ?? 0) * k, 0);
    const adjWorld = sections.reduce((sum, a) => sum + (Number(a['distance'] ?? 0) * k) / Number(a['scale'] ?? 1), 0);
    const scale = typeof s['map_scale'] === 'number' ? (s['map_scale'] as number) : j.game === 'ets2' ? 19 : 20;
    const world = (d - uk - adjKm) / scale + uk / 15 + adjWorld;
    j.game_km = round2(d);
    j.world_km = round2(world);
    j.scored_points = Math.floor(world / KM_PER_MI);
  }

  /** The submission (or nothing, for tracked jobs) with moderator edits laid over it. */
  private sheetInput(j: Job): Json {
    const base: Json = structuredClone(j.submission ?? {});
    for (const [k, v] of Object.entries(j.overrides ?? {})) {
      // adjusted_scales overrides are stored as the whole resulting list (see applyEdit).
      if (k === 'uk' && v && typeof v === 'object' && base[k]) base[k] = { ...(base[k] as Json), ...(v as Json) };
      else base[k] = v;
    }
    return base;
  }

  /** ADMIN_API §14. Returns the bad fields, or null when applied. */
  private applyEdit(j: Job, b: Json, actor: string, reason: string): Record<string, string> | null {
    const changes = Object.fromEntries(Object.entries(b).filter(([k]) => k !== 'reason' && k !== 'expected_etag'));
    const fields: Record<string, string> = {};
    for (const k of Object.keys(changes)) if (!EDIT_FIELDS.has(k)) fields[k] = 'unknown field';
    const distances =
      ['distance', 'uk'].some((k) => changes[k] !== undefined && changes[k] !== null) ||
      Object.values((changes['adjusted_scales'] as Json | null | undefined) ?? {}).some((s) => s && typeof s === 'object' && 'distance' in (s as Json));
    // Sections are edited by number in the current list; store the resulting list.
    if (changes['adjusted_scales'] !== undefined) {
      const edited = this.editSections(j, changes['adjusted_scales'], fields);
      if (edited) {
        checkSections(edited, changes['unit'] ?? this.sheetInput(j)['unit'], fields, false);
        changes['adjusted_scales'] = edited.length > 0 ? edited : null;
      }
    }
    if (distances && changes['unit'] !== 'mi' && changes['unit'] !== 'km') fields['unit'] = 'needed with a distance';
    if (typeof changes['fuel_used'] === 'number' && !changes['fuel_unit']) fields['fuel_unit'] = 'needed with fuel_used';
    const real = Object.keys(changes).filter((k) => k !== 'unit' && k !== 'fuel_unit');
    if (real.length === 0 && Object.keys(fields).length === 0) fields['(body)'] = 'nothing to change';
    if (Object.keys(fields).length > 0) return fields;

    const before = { points: j.points, held_points: j.held_points, overrides: structuredClone(j.overrides ?? {}) };
    j.overrides = { ...(j.overrides ?? {}), ...changes };
    if (j.origin === 'manual') {
      this.rescoreManual(j);
    } else if (typeof changes['distance'] === 'number') {
      const km = (changes['distance'] as number) * (changes['unit'] === 'mi' ? KM_PER_MI : 1);
      const ratio = j.game_km > 0 ? km / j.game_km : 1;
      j.game_km = round2(km);
      j.world_km = round2(j.world_km * ratio);
      j.scored_points = round2(j.scored_points * ratio);
    }
    if (j.outcome === 'valid' || j.outcome === 'approved') j.points = j.scored_points;
    if (j.outcome === 'pending_review') j.held_points = j.scored_points;
    j.version++;
    this.log(actor, 'job.edit', { kind: 'job', id: j.job_id }, reason, before, { points: j.points, held_points: j.held_points, overrides: j.overrides });
    return null;
  }

  /** ADMIN_API §14 section edits: a list replaces, null clears, keys change/remove/append. */
  private editSections(j: Job, edit: unknown, fields: Record<string, string>): Json[] | null {
    if (edit === null) return [];
    if (Array.isArray(edit)) return edit as Json[];
    const current = structuredClone(((this.sheetInput(j)['adjusted_scales'] as Json[] | null | undefined) ?? []));
    const result: (Json | null)[] = [...current];
    for (const [key, value] of Object.entries(edit as Json)) {
      const n = Number(key);
      if (!Number.isInteger(n) || n < 0 || n > current.length) {
        fields[`adjusted_scales[${key}]`] = 'no such section';
        continue;
      }
      if (value === null) result[n] = null;
      else if (n === current.length) result.push(value as Json);
      else result[n] = { ...(current[n] as Json), ...(value as Json) };
    }
    return result.filter((s): s is Json => s !== null);
  }

  private evidenceItem(e: { id: string; role: string; section?: number }): Json {
    const ev = this.evidence.get(e.id);
    return {
      evidence_id: e.id,
      role: e.role,
      section: e.section ?? null,
      content_type: ev?.content_type ?? 'image/webp',
      size_bytes: ev?.bytes.length ?? 0,
      url: `${BASE_URL}/dl/evidence/${e.id}?exp=1792000000&sig=x`,
      expires_at: NOW,
    };
  }

  private customMap(j: Job, admin: boolean): Json | null {
    const e = j.evidence?.find((x) => x.role === 'custom_map');
    if (!e || (j.hide_map && !admin)) return null;
    const item = this.evidenceItem(e);
    return { url: item['url'], expires_at: item['expires_at'] };
  }

  private reasons(j: Job): Json[] {
    if (j.origin === 'manual') return [{ code: 'manual_submission', text: 'Submitted by hand: a moderator checks the evidence.', details: {} }];
    return j.outcome === 'invalid' ? [{ code: 'overspeed_invalid', details: {} }] : [{ code: 'late_start', text: 'Tracking started after the job was accepted.', details: {} }];
  }

  private adminDetail(j: Job): Json {
    const s = this.sheetInput(j);
    const manual = j.origin === 'manual';
    const k = s['unit'] === 'mi' ? KM_PER_MI : 1;
    const sheet: Json = manual
      ? {
          distance_km: round2(Number(s['distance']) * k),
          distance_mi: round2((Number(s['distance']) * k) / KM_PER_MI),
          map_scale: s['map_scale'] ?? (j.game === 'ets2' ? 19 : 20),
          fuel_used_l: s['fuel_used'] ?? null,
          damage_pct: s['damage'] ?? null,
          profit: s['profit'] ?? null,
          started_at: s['started_at'],
          ended_at: s['ended_at'],
          truck: s['truck'],
          truck_model: s['truck_model'] ?? null,
          mods: s['mod_names'] ?? [],
          cargo_name: s['cargo_name'],
          source_city: s['start_city'],
          source_company: s['start_company'],
          destination_city: s['end_city'],
          destination_company: s['end_company'],
          uk: s['uk'] ? { ...(s['uk'] as Json), distance_km: round2(Number((s['uk'] as Json)['distance']) * k) } : null,
          adjusted_scales: ((s['adjusted_scales'] as Json[] | null | undefined) ?? []).map((a) => ({
            entry_city: a['entry_city'],
            exit_city: a['exit_city'],
            scale: a['scale'],
            distance_km: round2(Number(a['distance']) * k),
            distance_mi: round2((Number(a['distance']) * k) / KM_PER_MI),
            evidence_id: a['evidence'] ?? null,
          })),
        }
      : { distance_km: j.game_km, distance_mi: round2(j.game_km / KM_PER_MI), cargo_name: 'Vaccines', damage_pct: null, profit: null, truck: null, map_scale: null, uk: null, adjusted_scales: null };
    return {
      ...this.detail(j),
      reasons: this.reasons(j),
      etag: etag(j),
      state: 'delivered',
      start_kind: manual ? 'manual' : 'tracked',
      timeline: [],
      speed: manual ? null : { peak_mph: 61 },
      integrity: manual ? null : {},
      sheet,
      overrides: j.overrides ?? {},
      submission: manual ? { unit: j.submission!['unit'], fuel_unit: j.submission!['fuel_unit'], map_scale_defaulted: j.submission!['map_scale'] === undefined, sheet } : null,
      evidence: (j.evidence ?? []).map((e) => this.evidenceItem(e)),
      hide_map: j.hide_map ?? false,
      custom_map: this.customMap(j, true),
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
      outcomes: Object.fromEntries(
        (['valid', 'approved', 'pending_review', 'invalid', 'rejected', 'discarded', 'voided'] as const).map((o) => [o, jobs.filter((j) => j.outcome === o).length]),
      ),
      distance_by_scale_class: {
        city: { world_km: 0, world_mi: 0, game_km: 0, game_mi: 0 },
        road: { world_km: sum((j) => j.world_km), world_mi: sum((j) => j.world_km * 0.621371), game_km: sum((j) => j.game_km), game_mi: sum((j) => j.game_km * 0.621371) },
        one_to_one: { world_km: 0, world_mi: 0, game_km: 0, game_mi: 0 },
        nonstandard: { world_km: 0, world_mi: 0, game_km: 0, game_mi: 0 },
        unknown: { world_km: 0, world_mi: 0, game_km: 0, game_mi: 0 },
      },
    };
  }

  private summary(j: Job): Json {
    if (j.origin === 'manual') {
      const s = this.sheetInput(j);
      return {
        job_id: j.job_id,
        game: j.game,
        outcome: j.outcome,
        points: j.points,
        held_points: j.held_points,
        world_km: j.world_km,
        world_mi: round2(j.world_km / KM_PER_MI),
        game_km: j.game_km,
        game_mi: round2(j.game_km / KM_PER_MI),
        cargo: { id: null, name: s['cargo_name'] },
        source: { city_id: null, city_name: s['start_city'], company_id: null, company_name: s['start_company'] },
        destination: { city_id: null, city_name: s['end_city'], company_id: null, company_name: s['end_company'] },
        market: null,
        delivered_at: j.delivered_at,
        reported_delivered_at: s['ended_at'],
        multiplayer: { kind: 'unknown', truckersmp: null },
        origin: 'manual',
        ...this.extras(j),
      };
    }
    return {
      origin: 'tracked',
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
      ...this.extras(j),
      some_future_field: { ignored: true },
    };
  }

  /** fuel_used_l, damage_pct, income and currency (server 69fcfe9). Manual jobs use the sheet. */
  private extras(j: Job): Json {
    const currency = j.game === 'ets2' ? 'EUR' : 'USD';
    if (j.origin === 'manual') {
      const s = this.sheetInput(j);
      const perL: Record<string, number> = { l: 1, us_gal: 3.785411784, uk_gal: 4.54609 };
      const fuel = typeof s['fuel_used'] === 'number' ? round2((s['fuel_used'] as number) * (perL[String(s['fuel_unit'])] ?? 1)) : null;
      return { fuel_used_l: fuel, damage_pct: (s['damage'] as number | undefined) ?? null, income: (s['profit'] as number | undefined) ?? null, currency };
    }
    return { fuel_used_l: j.fuel_l ?? null, damage_pct: j.damage_pct ?? null, income: j.income ?? null, currency };
  }

  /** Totals of valid and approved jobs, as in history buckets and leaderboard items. */
  private totals(jobs: Job[]): Json {
    const counted = jobs.filter((j) => j.outcome === 'valid' || j.outcome === 'approved');
    const sum = (f: (j: Job) => number) => round2(counted.reduce((n, j) => n + f(j), 0));
    const ex = counted.map((j) => this.extras(j));
    const damages = ex.map((e) => e['damage_pct']).filter((d): d is number => typeof d === 'number');
    return {
      job_count: counted.length,
      points: sum((j) => j.points ?? 0),
      world_km: sum((j) => j.world_km),
      world_mi: sum((j) => j.world_km / KM_PER_MI),
      game_km: sum((j) => j.game_km),
      game_mi: sum((j) => j.game_km / KM_PER_MI),
      fuel_used_l: round2(ex.reduce((n, e) => n + ((e['fuel_used_l'] as number | null) ?? 0), 0)),
      income: ex.reduce((n, e) => n + ((e['income'] as number | null) ?? 0), 0),
      damage_pct_avg: damages.length > 0 ? round2(damages.reduce((a, b) => a + b, 0) / damages.length) : null,
    };
  }

  /** GET /public/{game}/players/{id}/history: every bucket up to now, empty ones as zeros. */
  private history(game: Job['game'], discordId: string, bucket: string): Json | null {
    const count = ({ day: 30, week: 12, month: 12 } as Record<string, number>)[bucket];
    if (!count) return null;
    const DAY = 86_400_000;
    const startOf = (ms: number) => {
      const d = new Date(ms);
      const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
      if (bucket === 'day') return day;
      if (bucket === 'month') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
      return day - ((d.getUTCDay() + 6) % 7) * DAY; // ISO weeks start on Monday
    };
    const step = (ms: number, n: number) => {
      const d = new Date(ms);
      if (bucket === 'month') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1);
      return ms + n * (bucket === 'day' ? 1 : 7) * DAY;
    };
    const start = step(startOf(Date.parse(NOW)), -(count - 1));
    const jobs = [...this.jobs.values()].filter((j) => j.game === game && j.owner === discordId);
    const before = (ms: number) => jobs.filter((j) => Date.parse(j.delivered_at) < ms);
    const iso = (ms: number) => new Date(ms).toISOString();
    const items: Json[] = [];
    for (let i = 0; i < count; i++) {
      const b = step(start, i);
      const e = step(start, i + 1);
      const inside = jobs.filter((j) => Date.parse(j.delivered_at) >= b && Date.parse(j.delivered_at) < e);
      items.push({ start: iso(b), end: iso(e), ...this.totals(inside), running: this.totals(before(e)) });
    }
    return {
      game,
      discord_user_id: discordId,
      bucket,
      currency: game === 'ets2' ? 'EUR' : 'USD',
      from: iso(start),
      to: items.at(-1)!['end'],
      before: this.totals(before(start)),
      items,
    };
  }

  /** Series points (ADMIN_API §5, and the public series of server 69fcfe9). */
  private series(j: Job, publicView: boolean): Json {
    const points = [0, 1, 2, 3].map((i) => ({
      t: new Date(Date.parse('2026-10-13T21:05:47.000Z') + i * 300_000).toISOString(),
      speed_mph_min: 0,
      speed_mph_max: [3.1, 52, 61, 0][i],
      fuel_l_min: 612.4 - i * 10,
      fuel_l_max: 612.5 - i * 10,
      damage_pct_min: i * 0.5,
      damage_pct_max: i * 0.5,
      game_km: round2((j.game_km * i) / 3),
      game_mi: round2((j.game_km * i) / 3 / KM_PER_MI),
      world_km: round2((j.world_km * i) / 3),
      world_mi: round2((j.world_km * i) / 3 / KM_PER_MI),
      reverted: false,
    }));
    const windows = [
      { kind: 'train', from: '2026-10-13T21:12:16.000Z', to: '2026-10-13T21:12:24.000Z' },
      { kind: 'reverted', from: '2026-10-13T21:14:00.000Z', to: '2026-10-13T21:15:00.000Z' },
    ];
    return {
      job_id: j.job_id,
      game: j.game,
      bucket_s: 300,
      penalty_over_mph: 100,
      invalid_over_mph: 150,
      points,
      // The public view hides reverted parts and review markers.
      windows: publicView ? windows.filter((w) => w.kind !== 'reverted') : windows,
      markers: publicView ? [] : [{ kind: 'fuel_jump', at: '2026-10-13T21:13:00.000Z', litres: 35 }],
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
      custom_map: this.customMap(j, false),
      ...(j.origin === 'manual' ? { planned_distance_km: null } : {}),
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
