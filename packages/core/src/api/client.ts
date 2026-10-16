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
  evidenceUploadSchema,
  gameStatsResponseSchema,
  jobDetailSchema,
  jobEditResultSchema,
  jobEvidenceSchema,
  jobSummarySchema,
  leaderboardSchema,
  playerHistorySchema,
  clientDownloadSchema,
  publicClientSchema,
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
  type HistoryBucket,
  type LeaderboardPeriod,
  type LeaderboardSort,
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

  /** Network failures, timeouts, 429 and 5xx are worth retrying; 501 never changes on retry. */
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || (this.status >= 500 && this.status !== 501);
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
  /** A non-JSON body (evidence images). */
  raw?: { bytes: Uint8Array<ArrayBuffer>; contentType: string };
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
  // Manual submissions (PUBLIC_API §6), on behalf of the player who ran the command.

  /** One image (WebP, PNG or JPEG, at most 5 MB). Unused uploads expire after 24 h. */
  uploadEvidence(discordId: string, bytes: Uint8Array<ArrayBuffer>, contentType: string, key: string) {
    return this.request('POST', `/players/${discordId}/evidence`, evidenceUploadSchema, {
      raw: { bytes, contentType },
      idempotencyKey: key,
    });
  }

  submitManualJob(discordId: string, job: ManualJobInput, key: string) {
    return this.request('POST', `/players/${discordId}/manual-jobs`, jobDetailSchema, { body: job, idempotencyKey: key });
  }

  /** The submitter's own images (404 for anyone else). Links are valid for an hour. */
  getOwnJobEvidence(discordId: string, jobId: string) {
    return this.request('GET', `/players/${discordId}/jobs/${jobId}/evidence`, jobEvidenceSchema);
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

  /** A player's whole history, both games, newest first. */
  listAllPlayerJobs(discordId: string, options: ListOptions & { outcome?: readonly string[] } = {}) {
    return this.request('GET', `/public/players/${discordId}/jobs`, pageSchema(jobSummarySchema), {
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

  /** A valid or approved tracked job's series, without reverted parts (404 for any other job). */
  /** A personal, hour-long setup link for a player (404 before any setup is published). */
  getClientDownload(discordId: string, platform: 'windows' = 'windows') {
    return this.request('GET', `/players/${discordId}/client-download`, clientDownloadSchema, { query: { platform } });
  }

  /** The newest release, with the public uninstaller link (404 before any release is offered). */
  getClient(platform: 'windows' = 'windows') {
    return this.request('GET', '/public/client', publicClientSchema, { query: { platform } });
  }

  getJobSeries(jobId: string, maxPoints = 1000) {
    return this.request('GET', `/public/jobs/${jobId}/series`, seriesSchema, { query: { max_points: maxPoints } });
  }

  getLeaderboard(
    game: Game,
    options: ListOptions & { period?: LeaderboardPeriod; at?: string; division?: Division; sort?: LeaderboardSort; order?: 'asc' | 'desc' } = {},
  ) {
    return this.request('GET', `/public/${game}/leaderboard`, leaderboardSchema, {
      query: { ...listQuery(options), period: options.period, at: options.at, division: options.division, sort: options.sort, order: options.order },
    });
  }

  /** Per-bucket totals of valid and approved jobs; `from`/`to` default on the server. */
  getPlayerHistory(game: Game, discordId: string, options: { bucket: HistoryBucket; from?: string; to?: string }) {
    return this.request('GET', `/public/${game}/players/${discordId}/history`, playerHistorySchema, {
      query: { bucket: options.bucket, from: options.from, to: options.to },
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
    if (options.raw) headers['Content-Type'] = options.raw.contentType;
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
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : options.raw ? { body: options.raw.bytes } : {}),
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
  /** `hideMap` and `corrections` are for approvals only (applied in the same step). */
  decide(
    jobId: string,
    decision: Decision,
    meta: WriteMeta & { expectedEtag?: string; hideMap?: boolean; corrections?: JobEdit },
  ) {
    return this.write('POST', `/jobs/${jobId}/${decision}`, decisionResultSchema, meta, {
      ...(meta.expectedEtag ? { expected_etag: meta.expectedEtag } : {}),
      ...(meta.hideMap !== undefined ? { hide_map: meta.hideMap } : {}),
      ...(meta.corrections && Object.keys(meta.corrections).length > 0 ? { corrections: meta.corrections } : {}),
    });
  }

  // §14 Edits: stored as overrides that survive re-scoring.
  editJob(jobId: string, changes: JobEdit, meta: WriteMeta & { expectedEtag?: string }) {
    return this.write('PATCH', `/jobs/${jobId}`, jobEditResultSchema, meta, {
      ...changes,
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

  /** Starts or stops offering a release's update to installed clients (422 without an update). */
  offerRelease(releaseId: string, offered: boolean, meta: WriteMeta) {
    return this.write('POST', `/releases/${releaseId}/offer`, releaseSchema, meta, { offered });
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

export type DistanceUnit = 'mi' | 'km';
export type FuelUnit = 'l' | 'us_gal' | 'uk_gal';

/** PUBLIC_API §6. Image fields hold evidence IDs from `uploadEvidence`. */
export interface ManualJobInput {
  game: Game;
  /** For every distance in the body. */
  unit: DistanceUnit;
  fuel_unit: FuelUnit;
  start_city: string;
  start_company: string;
  end_city: string;
  end_company: string;
  cargo_name: string;
  /** What the game logged (game distance). */
  distance: number;
  fuel_used: number;
  /** Percent, 0–100. */
  damage: number;
  /** In the game's currency. */
  profit: number;
  started_at: string;
  ended_at: string;
  truck: string;
  truck_model?: string;
  mod_names?: string[];
  /** Server default: ATS 20, ETS2 19. */
  map_scale?: number;
  uk?: { distance: number; entry_city: string; end_city: string; route_evidence: string };
  /** 0–5 sections driven at another scale (PUBLIC_API §6). */
  adjusted_scales?: AdjustedSectionInput[];
  evidence: string[];
  custom_map?: string;
}

export interface AdjustedSectionInput {
  entry_city: string;
  exit_city: string;
  distance: number;
  scale: number;
  evidence: string;
}

/** A section's fields as an edit may change them (no image). */
export type AdjustedSectionEdit = Partial<Omit<AdjustedSectionInput, 'evidence'>>;

/**
 * ADMIN_API §14: any field of any job. `null` clears damage, profit, fuel_used,
 * truck, truck_model, mod_names, map_scale, uk, adjusted_scales and bonus_id.
 * `adjusted_scales` is keyed by section number in the current sheet: an object changes
 * that section, `null` removes it, the next number appends.
 */
export interface JobEdit {
  unit?: DistanceUnit;
  fuel_unit?: FuelUnit;
  start_city?: string;
  start_company?: string;
  end_city?: string;
  end_company?: string;
  cargo_name?: string;
  distance?: number;
  fuel_used?: number | null;
  damage?: number | null;
  profit?: number | null;
  started_at?: string;
  ended_at?: string;
  truck?: string | null;
  truck_model?: string | null;
  mod_names?: string[] | null;
  map_scale?: number | null;
  uk?: { distance?: number; entry_city?: string; end_city?: string } | null;
  adjusted_scales?: Record<string, AdjustedSectionEdit | null> | null;
  bonus_id?: string | null;
  /** true adds the speed penalty, false removes it, null lets the speed rules decide again. */
  speed_penalty?: boolean | null;
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
