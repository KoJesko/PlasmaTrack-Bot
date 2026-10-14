import { z } from 'zod';
import { SCALE_CLASSES } from '../render/protocol.ts';

// Response shapes of the PlasmaTrack server API, v1 (docs/contract/, server
// commit 9592355). Hand-written from the contract's examples until the server
// publishes docs/openapi/bot-api.yaml; replace with generated types then.
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

export const gameStatsSchema = obj({
  points: z.number(),
  job_count: z.number().int(),
  world_km: z.number(),
  world_mi: z.number(),
  game_km: z.number(),
  game_mi: z.number(),
  pending_review_count: z.number().int(),
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

const placeSchema = obj({
  city_id: z.string(),
  city_name: z.string(),
  company_id: z.string().optional(),
  company_name: z.string().optional(),
});

export const multiplayerSchema = obj({
  kind: openEnum(['singleplayer', 'truckersmp', 'convoy']),
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
  cargo: obj({ id: z.string(), name: z.string() }),
  source: placeSchema,
  destination: placeSchema,
  market: z.string().optional(),
  delivered_at: timestamp,
  reported_delivered_at: timestamp.optional(),
  multiplayer: multiplayerSchema.optional(),
});
export type JobSummary = z.infer<typeof jobSummarySchema>;

const scaleDistance = obj({
  world_km: z.number(),
  game_km: z.number(),
  world_mi: z.number().optional(),
  game_mi: z.number().optional(),
});

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
  distance_by_scale_class: z.partialRecord(z.enum(SCALE_CLASSES), scaleDistance).optional(),
  public_notes: z.array(obj({ code: z.string(), text: z.string() })).default([]),
});
export type JobDetail = z.infer<typeof jobDetailSchema>;

// ---------------------------------------------------------------------------
// Route (PUBLIC_API §4, ADMIN_API §5)

export const SEGMENT_KINDS = ['driving', 'ferry', 'train', 'teleport', 'gap'] as const;
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
});

export const leaderboardSchema = pageSchema(leaderboardEntrySchema).extend({
  game,
  period: z.string(),
  at: z.string().nullable().optional(),
  division: z.string(),
  period_start: timestamp.nullable().optional(),
  period_end: timestamp.nullable().optional(),
  generated_at: timestamp.optional(),
});
export type Leaderboard = z.infer<typeof leaderboardSchema>;

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
  cargo: obj({ id: z.string(), name: z.string() }).optional(),
  source: obj({ city_id: z.string(), city_name: z.string() }).optional(),
  destination: obj({ city_id: z.string(), city_name: z.string() }).optional(),
  delivered_at: timestamp,
  age_s: z.number().optional(),
  reasons: z.array(reasonSchema).default([]),
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
  speed: z.record(z.string(), z.unknown()).optional(),
  fuel: z.record(z.string(), z.unknown()).optional(),
  rules: z.array(obj({ rule: z.string(), triggered: z.boolean() })).optional(),
  integrity: z.record(z.string(), z.unknown()).optional(),
  segments: z.array(obj({ status: z.string() })).optional(),
  timeline: z.array(obj({ at: timestamp, event: z.string() })).optional(),
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
});
export type Release = z.infer<typeof releaseSchema>;

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
