import type { z } from 'zod';
import {
  adminEntrySchema,
  adminJobDetailSchema,
  adminPlayerSchema,
  auditEntrySchema,
  bonusSchema,
  configVersionSchema,
  decisionResultSchema,
  errorBodySchema,
  gameStatsResponseSchema,
  jobDetailSchema,
  jobSummarySchema,
  leaderboardSchema,
  operationSchema,
  pageSchema,
  playerProfileSchema,
  recalculateJobSchema,
  recalculationDryRunSchema,
  recalculationStartedSchema,
  releaseSchema,
  reviewQueueCountSchema,
  reviewQueueItemSchema,
  revocationSchema,
  seriesSchema,
  serverRouteSchema,
  tokenIssueSchema,
  tokenMetaSchema,
  tokenRevokedSchema,
  traceLinkSchema,
  truckersmpFlagSchema,
  type Decision,
  type Division,
  type Game,
  type LeaderboardPeriod,
} from './schemas.ts';

// Client for the PlasmaTrack server API v1 (docs/contract/). Platform-free:
// plain fetch, no Node or Cloudflare APIs.
//
// Never log request or response bodies: token responses carry a player's
// plaintext token. Errors carry only the method, route and the server's
// error code.

export const API_PREFIX = '/api/v1';
export const REASON_MIN = 3;
export const REASON_MAX = 1000;
const DEFAULT_TIMEOUT_MS = 10_000;

export class ApiError extends Error {
  override name = 'ApiError';
  readonly status: number;
  /** The server's stable error code (`not_found`, `invalid_transition`…), or `network` / `timeout` / `bad_response`. */
  readonly code: string;
  readonly details: Record<string, unknown>;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    details: Record<string, unknown> = {},
    retryAfterSeconds?: number,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryAfterSeconds = retryAfterSeconds;
  }

  /** Network failures, timeouts, 429 and 5xx are worth retrying. */
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

/** Thrown before any request when a moderator's reason is out of range (API_CONVENTIONS §3). */
export class ReasonError extends Error {
  override name = 'ReasonError';
}

export function normalizeReason(reason: string): string {
  const r = reason.trim();
  if (r.length < REASON_MIN || r.length > REASON_MAX) {
    throw new ReasonError(`A reason of ${REASON_MIN}–${REASON_MAX} characters is required.`);
  }
  return r;
}

/**
 * Idempotency key for a write (API_CONVENTIONS §3): the Discord interaction ID
 * plus an operation label, so a queue retry of the same interaction replays
 * instead of applying twice.
 */
export function idempotencyKey(interactionId: string, operation: string): string {
  const key = `${interactionId}:${operation}`.replace(/[^\x21-\x7e]/g, '_');
  return key.slice(0, 128);
}

export interface ApiClientOptions {
  baseUrl: string;
  /** The bot token (API_CONVENTIONS §2). A secret: never logged. */
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface ListOptions {
  limit?: number;
  cursor?: string | null;
}

type Query = Record<string, string | number | boolean | null | undefined>;

interface RequestOptions {
  query?: Query;
  body?: unknown;
  idempotencyKey?: string;
  actor?: string;
}

export class PlasmaTrackApi {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  // -------------------------------------------------------------------------
  // Player self-service (PUBLIC_API §1). The Discord ID always comes from the
  // signed interaction, never from command input.

  /** Links (first call) or rotates. The result holds the plaintext token: show it ephemerally, never log or store it. */
  issueOwnToken(discordId: string, displayName: string, key: string) {
    return this.request('POST', `/players/${discordId}/token`, tokenIssueSchema, {
      body: { display_name: displayName },
      idempotencyKey: key,
    });
  }

  /** Active token metadata, or null when not linked / no active token. */
  getOwnToken(discordId: string) {
    return this.orNull(this.request('GET', `/players/${discordId}/token`, tokenMetaSchema));
  }

  revokeOwnToken(discordId: string, key: string) {
    return this.request('DELETE', `/players/${discordId}/token`, tokenRevokedSchema, { idempotencyKey: key });
  }

  setOwnDisplayName(discordId: string, displayName: string, key: string) {
    return this.request('PATCH', `/players/${discordId}`, playerProfileSchema, {
      body: { display_name: displayName },
      idempotencyKey: key,
    });
  }

  // -------------------------------------------------------------------------
  // Public reads (PUBLIC_API §2–5)

  getPlayer(discordId: string) {
    return this.request('GET', `/public/players/${discordId}`, playerProfileSchema);
  }

  getPlayerStats(game: Game, discordId: string) {
    return this.request('GET', `/public/${game}/players/${discordId}/stats`, gameStatsResponseSchema);
  }

  listPlayerJobs(game: Game, discordId: string, options: ListOptions & { outcome?: readonly string[] } = {}) {
    return this.request('GET', `/public/${game}/players/${discordId}/jobs`, pageSchema(jobSummarySchema), {
      query: { ...listQuery(options), outcome: options.outcome?.join(',') },
    });
  }

  /** `jobId` must be canonical (see `parseJobId`). */
  getJob(jobId: string) {
    return this.request('GET', `/public/jobs/${jobId}`, jobDetailSchema);
  }

  getRoute(jobId: string) {
    return this.request('GET', `/public/jobs/${jobId}/route`, serverRouteSchema);
  }

  getLeaderboard(
    game: Game,
    options: ListOptions & { period?: LeaderboardPeriod; at?: string; division?: Division } = {},
  ) {
    return this.request('GET', `/public/${game}/leaderboard`, leaderboardSchema, {
      query: { ...listQuery(options), period: options.period, at: options.at, division: options.division },
    });
  }

  // -------------------------------------------------------------------------

  /** Moderator calls on behalf of `actorDiscordId` (checked by the server, API_CONVENTIONS §2). */
  admin(actorDiscordId: string): AdminApi {
    return new AdminApi((method, path, schema, options = {}) =>
      this.request(method, `/admin${path}`, schema, { ...options, actor: actorDiscordId }),
    );
  }

  private async orNull<T>(p: Promise<T>): Promise<T | null> {
    try {
      return await p;
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  }

  private async request<S extends z.ZodType>(
    method: string,
    path: string,
    schema: S,
    options: RequestOptions = {},
  ): Promise<z.output<S>> {
    const url = new URL(this.baseUrl + API_PREFIX + path);
    for (const [k, v] of Object.entries(options.query ?? {})) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/json',
    };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
    if (options.actor) headers['X-PlasmaTrack-Actor'] = options.actor;

    const label = `${method} ${routeTemplate(path)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchFn(url.toString(), {
        method,
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        signal: controller.signal,
      });
    } catch (err) {
      const timedOut = controller.signal.aborted;
      throw new ApiError(0, timedOut ? 'timeout' : 'network', `${label}: ${timedOut ? 'timed out' : String(err)}`);
    } finally {
      clearTimeout(timer);
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      json = undefined;
    }

    if (!res.ok) {
      const parsed = errorBodySchema.safeParse(json);
      const code = parsed.success ? parsed.data.error.code : `http_${res.status}`;
      const details = parsed.success ? (parsed.data.error.details ?? {}) : {};
      throw new ApiError(res.status, code, `${label}: ${res.status} ${code}`, details, retryAfter(res, details));
    }

    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      // Paths only, never values: the body may hold a token.
      const paths = parsed.error.issues.slice(0, 5).map((i) => i.path.join('.') || '(root)');
      throw new ApiError(res.status, 'bad_response', `${label}: response did not match the contract at ${paths.join(', ')}`);
    }
    return parsed.data;
  }
}

type Requester = <S extends z.ZodType>(
  method: string,
  path: string,
  schema: S,
  options?: RequestOptions,
) => Promise<z.output<S>>;

export interface WriteMeta {
  reason: string;
  idempotencyKey: string;
}

/** ADMIN_API. Every write takes a reason (3–1000 characters, checked before sending) and an idempotency key. */
export class AdminApi {
  private readonly req: Requester;

  constructor(req: Requester) {
    this.req = req;
  }

  private write<S extends z.ZodType>(method: string, path: string, schema: S, meta: WriteMeta, body: object = {}) {
    return this.req(method, path, schema, {
      body: { ...body, reason: normalizeReason(meta.reason) },
      idempotencyKey: meta.idempotencyKey,
    });
  }

  // §1 Review queue
  reviewQueue(options: ListOptions & { game?: Game; outcome?: readonly string[]; reason?: string } = {}) {
    return this.req('GET', '/review-queue', pageSchema(reviewQueueItemSchema), {
      query: { ...listQuery(options), game: options.game, outcome: options.outcome?.join(','), reason: options.reason },
    });
  }

  reviewQueueCount(game?: Game) {
    return this.req('GET', '/review-queue/count', reviewQueueCountSchema, { query: { game } });
  }

  // §3 TruckersMP flags
  truckersmpFlags(options: ListOptions = {}) {
    return this.req('GET', '/truckersmp/flags', pageSchema(truckersmpFlagSchema), { query: listQuery(options) });
  }

  // §4–6 Job detail, series, route, trace
  job(jobId: string) {
    return this.req('GET', `/jobs/${jobId}`, adminJobDetailSchema);
  }

  series(jobId: string, maxPoints = 1000) {
    return this.req('GET', `/jobs/${jobId}/series`, seriesSchema, { query: { max_points: maxPoints } });
  }

  route(jobId: string) {
    return this.req('GET', `/jobs/${jobId}/route`, serverRouteSchema);
  }

  trace(jobId: string) {
    return this.req('GET', `/jobs/${jobId}/trace`, traceLinkSchema);
  }

  // §7 Decisions
  decide(jobId: string, decision: Decision, meta: WriteMeta & { expectedEtag?: string }) {
    return this.write('POST', `/jobs/${jobId}/${decision}`, decisionResultSchema, meta, {
      ...(meta.expectedEtag ? { expected_etag: meta.expectedEtag } : {}),
    });
  }

  // §8 Recalculation
  recalculateJob(jobId: string, meta: WriteMeta) {
    return this.write('POST', `/jobs/${jobId}/recalculate`, recalculateJobSchema, meta);
  }

  recalculationDryRun(game: Game | undefined, meta: WriteMeta) {
    return this.write('POST', '/recalculations', recalculationDryRunSchema, meta, { ...(game ? { game } : {}), dry_run: true });
  }

  startRecalculation(game: Game | undefined, meta: WriteMeta) {
    return this.write('POST', '/recalculations', recalculationStartedSchema, meta, { ...(game ? { game } : {}), dry_run: false });
  }

  operation(operationId: string) {
    return this.req('GET', `/operations/${operationId}`, operationSchema);
  }

  // §9 Bonuses
  listBonuses(options: ListOptions & { game?: Game; status?: string } = {}) {
    return this.req('GET', '/bonuses', pageSchema(bonusSchema), {
      query: { ...listQuery(options), game: options.game, status: options.status },
    });
  }

  getBonus(bonusId: string) {
    return this.req('GET', `/bonuses/${bonusId}`, bonusSchema);
  }

  createBonus(bonus: BonusInput, meta: WriteMeta) {
    return this.write('POST', '/bonuses', bonusSchema, meta, bonus);
  }

  updateBonus(bonusId: string, changes: Partial<BonusInput>, meta: WriteMeta) {
    return this.write('PATCH', `/bonuses/${bonusId}`, bonusSchema, meta, changes);
  }

  archiveBonus(bonusId: string, meta: WriteMeta) {
    return this.write('DELETE', `/bonuses/${bonusId}`, bonusSchema, meta);
  }

  // §10 Players and tokens
  player(discordId: string) {
    return this.req('GET', `/players/${discordId}`, adminPlayerSchema);
  }

  /** Returns the plaintext token: show it only to the player (ADMIN_API §10), never log or store it. */
  issueToken(discordId: string, displayName: string | undefined, meta: WriteMeta) {
    return this.write('POST', `/players/${discordId}/token`, tokenIssueSchema, meta, displayName ? { display_name: displayName } : {});
  }

  revokeToken(discordId: string, meta: WriteMeta) {
    return this.write('DELETE', `/players/${discordId}/token`, tokenRevokedSchema, meta);
  }

  updatePlayer(
    discordId: string,
    changes: { singleplayer_division?: boolean; disabled?: boolean; display_name?: string },
    meta: WriteMeta,
  ) {
    return this.write('PATCH', `/players/${discordId}`, adminPlayerSchema, meta, changes);
  }

  // §11 Config versions, releases, revocations
  listConfigVersions(options: ListOptions = {}) {
    return this.req('GET', '/config-versions', pageSchema(configVersionSchema), { query: listQuery(options) });
  }

  publishConfigVersion(toml: string, makeCurrent: boolean, meta: WriteMeta) {
    return this.write('POST', '/config-versions', configVersionSchema, meta, { toml, make_current: makeCurrent });
  }

  makeConfigVersionCurrent(versionId: string, meta: WriteMeta) {
    return this.write('POST', `/config-versions/${versionId}/make-current`, configVersionSchema, meta);
  }

  listReleases(options: ListOptions = {}) {
    return this.req('GET', '/releases', pageSchema(releaseSchema), { query: listQuery(options) });
  }

  publishRelease(release: ReleaseInput, meta: WriteMeta) {
    return this.write('POST', '/releases', releaseSchema, meta, release);
  }

  listRevocations(options: ListOptions & { status?: string } = {}) {
    return this.req('GET', '/revocations', pageSchema(revocationSchema), {
      query: { ...listQuery(options), status: options.status },
    });
  }

  scheduleRevocation(target: { kind: 'release' | 'config_version'; id: string }, meta: WriteMeta) {
    return this.write('POST', '/revocations', revocationSchema, meta, { target });
  }

  cancelRevocation(revocationId: string, meta: WriteMeta) {
    return this.write('POST', `/revocations/${revocationId}/cancel`, revocationSchema, meta);
  }

  // §12 Admins
  listAdmins(options: ListOptions = {}) {
    return this.req('GET', '/admins', pageSchema(adminEntrySchema), { query: listQuery(options) });
  }

  addAdmin(discordId: string, meta: WriteMeta) {
    return this.write('POST', '/admins', adminEntrySchema, meta, { discord_user_id: discordId });
  }

  removeAdmin(discordId: string, meta: WriteMeta) {
    return this.write('DELETE', `/admins/${discordId}`, adminEntrySchema.partial(), meta);
  }

  // §13 Audit
  audit(
    filters: ListOptions & {
      job_id?: string;
      actor?: string;
      target_user?: string;
      action?: string;
      since?: string;
      until?: string;
    } = {},
  ) {
    const { limit, cursor, ...rest } = filters;
    return this.req('GET', '/audit', pageSchema(auditEntrySchema), { query: { ...listQuery({ limit, cursor }), ...rest } });
  }
}

export interface BonusInput {
  game: Game;
  label: string;
  match: string;
  match_kind: 'exact' | 'glob';
  kind: 'flat' | 'multiplier';
  amount: number;
  active_from: string;
  active_to: string;
}

export interface ReleaseInput {
  release_version: string;
  platform: 'windows' | 'linux';
  files: { role: 'plugin' | 'client_binary' | 'config_file'; path_pattern: string; sha256: string }[];
}

function listQuery(options: ListOptions): Query {
  return { limit: options.limit, cursor: options.cursor ?? undefined };
}

function retryAfter(res: Response, details: Record<string, unknown>): number | undefined {
  const header = Number(res.headers.get('Retry-After'));
  if (Number.isFinite(header) && header > 0) return header;
  const fromBody = details['retry_after_s'];
  return typeof fromBody === 'number' && fromBody > 0 ? fromBody : undefined;
}

/** Log-safe route: IDs replaced by placeholders. */
export function routeTemplate(path: string): string {
  return path
    .replace(/\d{17,20}/g, ':discord_id')
    .replace(/\/jobs\/[0-9A-Z]{8}(?=\/|$)/g, '/jobs/:job_id')
    .replace(/\/(bon|cfg|rel|rev|op|usr|tok)_[A-Za-z0-9_]+/g, '/:$1_id');
}
