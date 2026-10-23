import { z } from 'zod';
import { SCALE_CLASSES } from '../render/protocol.ts';

// Response shapes of the PlasmaTrack server API, v1 (docs/contract/). Hand-written
// from the contract; test/contract-examples.test.ts checks them against the
// server's real example responses.
//
// Contract rules applied everywhere (API_CONVENTIONS §1):
// - unknown fields are ignored (every object is loose);
// - unknown enum values become "other".

/** An enum that maps values it doesn't know to `'other'` instead of failing. */
export function openEnum<const T extends readonly [string, ...string[]]>(values: T) {
  return z.string().transform((v): T[number] | 'other' => ((values as readonly string[]).includes(v) ? v : 'other'));
}

const obj = <S extends z.ZodRawShape>(shape: S) => z.looseObject(shape);

export const GAMES = ['ets2', 'ats'] as const;
export type Game = (typeof GAMES)[number];
const game = z.enum(GAMES);

const timestamp = z.string();
const nullableNumber = z.number().nullable();

// ---------------------------------------------------------------------------
// Errors and lists (API_CONVENTIONS §4, §5)

export const errorBodySchema = obj({
  error: obj({
    code: z.string(),
    message: z.string().optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});

export function pageSchema<T extends z.ZodType>(item: T) {
  return obj({
    items: z.array(item),
    next_cursor: z.string().nullable().optional().transform((c) => c ?? null),
    total: z.number().int().optional(),
  });
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
  total?: number | undefined;
}

// ---------------------------------------------------------------------------
// Players and tokens (PUBLIC_API §1, §2)

export const playerRefSchema = obj({
  user_id: z.string(),
  discord_user_id: z.string(),
  display_name: z.string(),
});
export type PlayerRef = z.infer<typeof playerRefSchema>;

export const tokenIssueSchema = obj({
  user: obj({
    user_id: z.string(),
    discord_user_id: z.string(),
    display_name: z.string(),
    created: z.boolean().optional(),
  }),
  token: obj({
    token_id: z.string(),
    /** Plaintext, present exactly once. Never log, queue or store it. Null on an idempotent replay. */
    token: z.string().nullable(),
    created_at: timestamp,
    revoked_token_id: z.string().nullable().optional(),
  }),
});
export type TokenIssue = z.infer<typeof tokenIssueSchema>;

export const tokenMetaSchema = obj({
  token_id: z.string(),
  created_at: timestamp,
  last_used_at: timestamp.nullable().optional(),
});
export type TokenMeta = z.infer<typeof tokenMetaSchema>;

export const tokenRevokedSchema = obj({ revoked_token_id: z.string().nullable() });

const scaleDistance = obj({
  world_km: z.number(),
  game_km: z.number(),
  world_mi: z.number().optional(),
  game_mi: z.number().optional(),
});
const distanceByScaleClass = z.partialRecord(z.enum(SCALE_CLASSES), scaleDistance);

export const gameStatsSchema = obj({
  points: z.number(),
  job_count: z.number().int(),
  world_km: z.number(),
  world_mi: z.number(),
  game_km: z.number(),
  game_mi: z.number(),
  pending_review_count: z.number().int(),
  /** Finished jobs per outcome (all seven keys). */
  outcomes: z.record(z.string(), z.number().int()).optional(),
  /** Totals of valid and approved jobs. */
  distance_by_scale_class: distanceByScaleClass.optional(),
});
export type GameStats = z.infer<typeof gameStatsSchema>;

export const truckersmpAccountSchema = obj({
  account_id: z.number().int(),
  profile_url: z.string().optional(),
  first_seen_at: timestamp.optional(),
  last_seen_at: timestamp.optional(),
  job_count: z.number().int().optional(),
});

const linkedPlayerSchema = obj({
  linked: z.literal(true),
  user_id: z.string(),
  discord_user_id: z.string(),
  display_name: z.string(),
  singleplayer_division: z.boolean(),
  disabled: z.boolean(),
  truckersmp_accounts: z.array(truckersmpAccountSchema).default([]),
  stats: obj({ ets2: gameStatsSchema, ats: gameStatsSchema }),
});

export const playerProfileSchema = z.discriminatedUnion('linked', [
  linkedPlayerSchema,
  obj({ linked: z.literal(false), discord_user_id: z.string() }),
]);
export type PlayerProfile = z.infer<typeof playerProfileSchema>;

export const gameStatsResponseSchema = gameStatsSchema.extend({ game });

// ---------------------------------------------------------------------------
// Jobs (PUBLIC_API §3)

export const OUTCOMES = ['valid', 'approved', 'pending_review', 'invalid', 'rejected', 'discarded', 'voided'] as const;
export const outcomeSchema = openEnum(OUTCOMES);
export type Outcome = z.infer<typeof outcomeSchema>;

/** IDs are null on manual jobs: only names were typed. */
const placeSchema = obj({
  city_id: z.string().nullable(),
  city_name: z.string(),
  company_id: z.string().nullable().optional(),
  company_name: z.string().nullable().optional(),
});

export const ORIGINS = ['tracked', 'manual'] as const;
/** `manual`: submitted through the bot (PUBLIC_API §6). Missing means tracked. */
const originSchema = openEnum(ORIGINS).optional();

export const MULTIPLAYER_KINDS = ['singleplayer', 'truckersmp', 'convoy', 'unknown', 'haulmp', 'trucklinemp'] as const;

/**
 * `kind` may also be any multiplayer mod from the server config's
 * `[[multiplayer.mods]]` (PUBLIC_API §3); for those, `name` is its display
 * name (`HaulMP`). Show `name` when present, so a new mod needs no bot change.
 */
export const multiplayerSchema = obj({
  kind: openEnum(MULTIPLAYER_KINDS),
  name: z.string().optional(),
  truckersmp: obj({ server_id: z.number().int().nullable().optional(), account_id: z.number().int().nullable().optional() })
    .nullable()
    .optional(),
});

export const jobSummarySchema = obj({
  job_id: z.string(),
  game,
  outcome: outcomeSchema,
  points: nullableNumber,
  held_points: nullableNumber.optional(),
  world_km: z.number(),
  world_mi: z.number(),
  game_km: z.number(),
  game_mi: z.number(),
  cargo: obj({ id: z.string().nullable(), name: z.string() }),
  source: placeSchema,
  destination: placeSchema,
  market: z.string().nullable().optional(),
  delivered_at: timestamp,
  reported_delivered_at: timestamp.optional(),
  multiplayer: multiplayerSchema.optional(),
  origin: originSchema,
  /** Server 69fcfe9: null when unknown. `damage_pct` is cargo damage at delivery. */
  fuel_used_l: nullableNumber.optional(),
  /** `false` (with `fuel_used_l: null`) when the readings are beyond any real tank; absent otherwise. */
  fuel_readable: z.boolean().optional(),
  damage_pct: nullableNumber.optional(),
  /** Whole units of `currency` (EUR for ETS2, USD for ATS); a manual job's submitted profit. */
  income: nullableNumber.optional(),
  currency: z.string().optional(),
});
export type JobSummary = z.infer<typeof jobSummarySchema>;

/** A signed image link, valid for an hour: fetch it when showing the job. */
export const signedLinkSchema = obj({ url: z.string(), expires_at: timestamp });

export const jobBonusSchema = obj({
  bonus_id: z.string(),
  label: z.string(),
  kind: openEnum(['flat', 'multiplier']),
  amount: z.number(),
});

export const jobDetailSchema = jobSummarySchema.extend({
  player: playerRefSchema,
  planned_distance_km: nullableNumber.optional(),
  speed_penalty_applied: z.boolean().optional(),
  bonus: jobBonusSchema.nullable().optional(),
  distance_by_scale_class: distanceByScaleClass.optional(),
  public_notes: z.array(obj({ code: z.string(), text: z.string() })).default([]),
  /** A manual job's custom map; null when there is none or it was hidden. */
  custom_map: signedLinkSchema.nullable().optional(),
});
export type JobDetail = z.infer<typeof jobDetailSchema>;

// ---------------------------------------------------------------------------
// Manual submissions (PUBLIC_API §6)

export const EVIDENCE_ROLES = ['main', 'custom_map', 'uk_route', 'adjusted_scale'] as const;

export const evidenceUploadSchema = obj({
  evidence_id: z.string(),
  content_type: z.string(),
  size_bytes: z.number().int(),
  expires_at: timestamp.optional(),
});
export type EvidenceUpload = z.infer<typeof evidenceUploadSchema>;

export const evidenceItemSchema = obj({
  evidence_id: z.string(),
  role: openEnum(EVIDENCE_ROLES),
  /** For `adjusted_scale` images: the section shown, from 0 as submitted. Null otherwise. */
  section: z.number().int().nullable().optional(),
  content_type: z.string(),
  size_bytes: z.number().int().optional(),
  url: z.string(),
  expires_at: timestamp,
});
export type EvidenceItem = z.infer<typeof evidenceItemSchema>;

export const jobEvidenceSchema = obj({ job_id: z.string(), items: z.array(evidenceItemSchema) });

/** Effective values in canonical units (ADMIN_API §4). Fields a recording can't know are null. */
export const sheetSchema = obj({
  distance_km: nullableNumber.optional(),
  distance_mi: nullableNumber.optional(),
  map_scale: nullableNumber.optional(),
  fuel_used_l: nullableNumber.optional(),
  damage_pct: nullableNumber.optional(),
  profit: nullableNumber.optional(),
  started_at: timestamp.nullable().optional(),
  ended_at: timestamp.nullable().optional(),
  truck: z.string().nullable().optional(),
  truck_model: z.string().nullable().optional(),
  mods: z.array(z.string()).nullable().optional(),
  cargo_name: z.string().nullable().optional(),
  source_city: z.string().nullable().optional(),
  source_company: z.string().nullable().optional(),
  destination_city: z.string().nullable().optional(),
  destination_company: z.string().nullable().optional(),
  uk: obj({
    distance_km: nullableNumber.optional(),
    distance_mi: nullableNumber.optional(),
    entry_city: z.string().nullable().optional(),
    end_city: z.string().nullable().optional(),
  })
    .nullable()
    .optional(),
  /** Up to 5 sections at other scales (owner, 2026-10-15), numbered from 0 in this order. */
  adjusted_scales: z
    .array(
      obj({
        distance_km: nullableNumber.optional(),
        distance_mi: nullableNumber.optional(),
        scale: nullableNumber.optional(),
        entry_city: z.string().nullable().optional(),
        exit_city: z.string().nullable().optional(),
        evidence_id: z.string().nullable().optional(),
      }),
    )
    .nullable()
    .optional(),
});
export type Sheet = z.infer<typeof sheetSchema>;

// ---------------------------------------------------------------------------
// Route (PUBLIC_API §4, ADMIN_API §5)

/** `ferry_or_train`: a crossing the game didn't name (server, 2026-10-15). */
export const SEGMENT_KINDS = ['driving', 'ferry', 'train', 'ferry_or_train', 'teleport', 'gap'] as const;
export const SEGMENT_STATUSES = ['kept', 'reverted', 'restored'] as const;

const position = z.array(z.number()).min(2);

export const serverRouteFeatureSchema = obj({
  type: z.literal('Feature'),
  geometry: obj({ type: z.literal('LineString'), coordinates: z.array(position) }),
  properties: obj({
    index: z.number().int().optional(),
    segment: openEnum(SEGMENT_KINDS).optional(),
    local_scale: nullableNumber.optional(),
    scale_class: openEnum(SCALE_CLASSES).optional(),
    counted: z.boolean().optional(),
    status: openEnum(SEGMENT_STATUSES).optional(),
    world_km: z.number().optional(),
    game_km: z.number().optional(),
  }),
});

export const serverRouteSchema = obj({
  type: z.literal('FeatureCollection'),
  bbox: z.array(z.number()).optional(),
  properties: obj({
    job_id: z.string(),
    game,
    vertex_count: z.number().int().optional(),
    max_vertices: z.number().int().optional(),
    simplification_tolerance_world_m: z.number().optional(),
    includes_reverted: z.boolean().optional(),
  }),
  features: z.array(serverRouteFeatureSchema),
});
export type ServerRoute = z.infer<typeof serverRouteSchema>;

// ---------------------------------------------------------------------------
// Leaderboards (PUBLIC_API §5)

export const LEADERBOARD_PERIODS = ['all', 'month', 'week'] as const;
export type LeaderboardPeriod = (typeof LEADERBOARD_PERIODS)[number];
export const DIVISIONS = ['all', 'singleplayer'] as const;
export type Division = (typeof DIVISIONS)[number];

export const leaderboardEntrySchema = obj({
  rank: z.number().int(),
  user_id: z.string(),
  discord_user_id: z.string(),
  display_name: z.string(),
  points: z.number(),
  job_count: z.number().int(),
  world_km: z.number(),
  world_mi: z.number(),
  game_km: z.number(),
  game_mi: z.number(),
  fuel_used_l: nullableNumber.optional(),
  income: nullableNumber.optional(),
  damage_pct_avg: nullableNumber.optional(),
});

/** What a leaderboard can rank by (server 69fcfe9). Damage ranks least first by default. */
export const LEADERBOARD_SORTS = ['points', 'distance', 'game_distance', 'fuel', 'income', 'damage'] as const;
export type LeaderboardSort = (typeof LEADERBOARD_SORTS)[number];

export const leaderboardSchema = pageSchema(leaderboardEntrySchema).extend({
  game,
  period: z.string(),
  at: z.string().nullable().optional(),
  division: z.string(),
  period_start: timestamp.nullable().optional(),
  period_end: timestamp.nullable().optional(),
  generated_at: timestamp.optional(),
  sort: z.string().optional(),
  order: z.string().optional(),
  currency: z.string().optional(),
});
export type Leaderboard = z.infer<typeof leaderboardSchema>;

// ---------------------------------------------------------------------------
// Player history buckets (PUBLIC_API, server 69fcfe9)

export const HISTORY_BUCKETS = ['day', 'week', 'month'] as const;
export type HistoryBucket = (typeof HISTORY_BUCKETS)[number];

const historyTotalsShape = {
  job_count: z.number().int(),
  points: z.number(),
  world_km: z.number(),
  world_mi: z.number(),
  game_km: z.number(),
  game_mi: z.number(),
  fuel_used_l: z.number(),
  income: z.number(),
  damage_pct_avg: nullableNumber,
};
export const historyTotalsSchema = obj(historyTotalsShape);
export type HistoryTotals = z.infer<typeof historyTotalsSchema>;

export const playerHistorySchema = obj({
  game,
  discord_user_id: z.string(),
  bucket: z.string(),
  currency: z.string(),
  from: timestamp,
  to: timestamp,
  /** All-time totals before `from`. */
  before: historyTotalsSchema,
  items: z.array(
    obj({
      start: timestamp,
      end: timestamp,
      ...historyTotalsShape,
      /** All-time totals up to this bucket's end. */
      running: historyTotalsSchema,
    }),
  ),
});
export type PlayerHistory = z.infer<typeof playerHistorySchema>;

// ---------------------------------------------------------------------------
// Moderation (ADMIN_API)

export const reasonSchema = obj({
  code: z.string(),
  text: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ReviewReason = z.infer<typeof reasonSchema>;

export const reviewQueueItemSchema = obj({
  job_id: z.string(),
  game,
  outcome: outcomeSchema,
  player: playerRefSchema,
  held_points: nullableNumber.optional(),
  world_km: z.number().optional(),
  game_km: z.number().optional(),
  cargo: obj({ id: z.string().nullable(), name: z.string() }).optional(),
  source: obj({ city_id: z.string().nullable(), city_name: z.string() }).optional(),
  destination: obj({ city_id: z.string().nullable(), city_name: z.string() }).optional(),
  delivered_at: timestamp,
  age_s: z.number().optional(),
  reasons: z.array(reasonSchema).default([]),
  origin: originSchema,
});
export type ReviewQueueItem = z.infer<typeof reviewQueueItemSchema>;

export const reviewQueueCountSchema = obj({
  pending_review: z.number().int(),
  invalid: z.number().int(),
  by_reason: z.record(z.string(), z.number().int()).default({}),
});

export const adminJobDetailSchema = jobDetailSchema.extend({
  reasons: z.array(reasonSchema).default([]),
  etag: z.string(),
  state: z.string().optional(),
  start_kind: z.string().optional(),
  // The rest is shown to moderators mostly as-is; kept loose on purpose.
  distances: z.record(z.string(), z.unknown()).optional(),
  // Null on manual jobs.
  speed: z.record(z.string(), z.unknown()).nullable().optional(),
  fuel: z.record(z.string(), z.unknown()).optional(),
  rules: z.array(obj({ rule: z.string(), triggered: z.boolean() })).optional(),
  integrity: z.record(z.string(), z.unknown()).nullable().optional(),
  segments: z.array(obj({ status: z.string() })).optional(),
  timeline: z.array(obj({ at: timestamp, event: z.string() })).optional(),
  // Stats sheet, edits and manual jobs (ADMIN_API §4, §14).
  sheet: sheetSchema.nullable().optional(),
  overrides: z.record(z.string(), z.unknown()).default({}),
  submission: obj({ unit: z.string(), fuel_unit: z.string(), map_scale_defaulted: z.boolean().optional(), sheet: sheetSchema.optional() })
    .nullable()
    .optional(),
  evidence: z.array(evidenceItemSchema).default([]),
  hide_map: z.boolean().optional(),
});
export type AdminJobDetail = z.infer<typeof adminJobDetailSchema>;

export const seriesSchema = obj({
  job_id: z.string(),
  game,
  bucket_s: z.number(),
  penalty_over_mph: z.number().optional(),
  invalid_over_mph: z.number().optional(),
  points: z.array(
    obj({
      t: timestamp,
      speed_mph_min: nullableNumber,
      speed_mph_max: nullableNumber,
      fuel_l_min: nullableNumber.optional(),
      fuel_l_max: nullableNumber.optional(),
      /** Cargo damage; null for data processed before server 69fcfe9. */
      damage_pct_min: nullableNumber.optional(),
      damage_pct_max: nullableNumber.optional(),
      /** Odometer from the job's start (all driving), at the bucket's end. */
      game_km: nullableNumber.optional(),
      game_mi: nullableNumber.optional(),
      /** The scored part at 1:1 from the start. */
      world_km: nullableNumber.optional(),
      world_mi: nullableNumber.optional(),
      reverted: z.boolean().optional(),
    }),
  ),
  windows: z.array(obj({ kind: z.string(), from: timestamp, to: timestamp, litres: z.number().optional() })).default([]),
  markers: z.array(obj({ kind: z.string(), at: timestamp, litres: z.number().optional() })).default([]),
});
export type Series = z.infer<typeof seriesSchema>;

export const traceLinkSchema = obj({
  url: z.string(),
  expires_at: timestamp,
  size_bytes: z.number().int(),
  format: z.string(),
  frames: z.number().int().optional(),
});
export type TraceLink = z.infer<typeof traceLinkSchema>;

export const DECISIONS = ['approve', 'reject', 'void', 'restore'] as const;
export type Decision = (typeof DECISIONS)[number];

export const decisionResultSchema = obj({
  job_id: z.string(),
  outcome: outcomeSchema,
  points: nullableNumber,
  held_points: nullableNumber.optional(),
  etag: z.string(),
});
export type DecisionResult = z.infer<typeof decisionResultSchema>;

export const jobEditResultSchema = decisionResultSchema.extend({ overrides: z.record(z.string(), z.unknown()).default({}) });
export type JobEditResult = z.infer<typeof jobEditResultSchema>;

const outcomeSnapshot = obj({ outcome: outcomeSchema, points: nullableNumber, held_points: nullableNumber.optional() });

export const recalculateJobSchema = obj({
  job_id: z.string(),
  before: outcomeSnapshot,
  after: outcomeSnapshot,
  etag: z.string(),
});

export const recalculationDryRunSchema = obj({ affected_jobs: z.number().int(), game: game.nullable().optional() });
export const recalculationStartedSchema = obj({ operation_id: z.string(), affected_jobs: z.number().int() });

export const operationSchema = obj({
  operation_id: z.string(),
  kind: z.string(),
  status: openEnum(['queued', 'running', 'succeeded', 'failed']),
  progress: obj({ done: z.number().int(), total: z.number().int() }).nullable().optional(),
  started_at: timestamp.nullable().optional(),
  finished_at: timestamp.nullable().optional(),
  summary: z.record(z.string(), z.unknown()).nullable().optional(),
});
export type Operation = z.infer<typeof operationSchema>;

export const bonusSchema = obj({
  bonus_id: z.string(),
  game,
  label: z.string(),
  match: z.string(),
  match_kind: openEnum(['exact', 'glob']),
  kind: openEnum(['flat', 'multiplier']),
  amount: z.number(),
  active_from: timestamp,
  active_to: timestamp,
  status: openEnum(['active', 'scheduled', 'ended', 'archived']),
  created_at: timestamp.optional(),
  updated_at: timestamp.optional(),
});
export type Bonus = z.infer<typeof bonusSchema>;

export const truckersmpFlagSchema = obj({ kind: z.string() });

export const adminPlayerSchema = z.union([
  linkedPlayerSchema.extend({
    role: z.string().optional(),
    created_at: timestamp.optional(),
    token: tokenMetaSchema.nullable().optional(),
    truckersmp_flags: z.array(truckersmpFlagSchema).optional(),
  }),
  obj({ linked: z.literal(false), discord_user_id: z.string() }),
]);
export type AdminPlayer = z.infer<typeof adminPlayerSchema>;

export const configVersionSchema = obj({
  version_id: z.string(),
  integrity_hash: z.string(),
  current: z.boolean(),
  created_at: timestamp.optional(),
});
export type ConfigVersion = z.infer<typeof configVersionSchema>;

export const RELEASE_FILE_ROLES = ['plugin', 'client_binary', 'config_file'] as const;

export const releaseSchema = obj({
  release_id: z.string().optional(),
  release_version: z.string(),
  platform: z.string(),
  files: z.array(obj({ role: z.string(), path_pattern: z.string(), sha256: z.string() })).optional(),
  created_at: timestamp.optional(),
  /** Self-updating clients (server 68abaf0): the signed update, if any, and whether it's offered. */
  update: obj({ files: z.number().int(), bytes: z.number().int() }).nullable().optional(),
  installer: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  offered: z.boolean().optional(),
});
export type Release = z.infer<typeof releaseSchema>;

// ---------------------------------------------------------------------------
// Downloading PlasmaTrack (PUBLIC_API §7, owner 2026-10-15)

/** A personal setup link: signed, works for an hour without a token. Show it privately. */
export const clientDownloadSchema = obj({
  platform: z.string(),
  release_id: z.string(),
  version: z.string(),
  notes: z.string().nullable().optional(),
  file_name: z.string(),
  bytes: z.number().int(),
  url: z.string(),
  expires_at: timestamp,
});
export type ClientDownload = z.infer<typeof clientDownloadSchema>;

/** The newest offered release; the uninstaller link is public and never changes. */
export const publicClientSchema = obj({
  platform: z.string(),
  release_id: z.string(),
  version: z.string(),
  published_at: timestamp.optional(),
  notes: z.string().nullable().optional(),
  installer: obj({ file_name: z.string(), bytes: z.number().int() }).nullable().optional(),
  uninstaller: obj({ file_name: z.string(), bytes: z.number().int(), url: z.string() }).nullable().optional(),
});
export type PublicClient = z.infer<typeof publicClientSchema>;

export const revocationSchema = obj({
  revocation_id: z.string(),
  target: obj({ kind: openEnum(['release', 'config_version']), id: z.string(), label: z.string().optional() }).optional(),
  announced_at: timestamp,
  effective_at: timestamp,
  recipients_count: z.number().int().optional(),
  status: openEnum(['scheduled', 'effective', 'cancelled']).optional(),
});
export type Revocation = z.infer<typeof revocationSchema>;

export const adminEntrySchema = obj({ discord_user_id: z.string(), display_name: z.string().optional() });

export const auditEntrySchema = obj({
  audit_id: z.string(),
  at: timestamp,
  actor: obj({ discord_user_id: z.string().nullable().optional(), display_name: z.string().optional() }).or(z.string()),
  action: z.string(),
  target: obj({ kind: z.string(), id: z.string() }).optional(),
  reason: z.string().nullable().optional(),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;
