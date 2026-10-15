import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import * as S from '../src/api/schemas.ts';
import * as E from '../src/webhooks/events.ts';

// Real responses and webhooks from the server (docs/examples at the commit in
// fixtures/server-examples/SOURCE; refresh with scripts/sync-contract.mjs).
// Every one must parse with the schema the bot uses for it.

const dir = join(import.meta.dirname, 'fixtures', 'server-examples');
const page = S.pageSchema;

const RESPONSES: Record<string, z.ZodType> = {
  admin_admin_add: S.adminEntrySchema,
  admin_admin_remove: S.adminEntrySchema.partial(),
  admin_admins: page(S.adminEntrySchema),
  admin_audit: page(S.auditEntrySchema),
  admin_bonus: S.bonusSchema,
  admin_bonus_archive: S.bonusSchema,
  admin_bonus_create: S.bonusSchema,
  admin_bonus_update: S.bonusSchema,
  admin_bonuses: page(S.bonusSchema),
  admin_config_version_create: S.configVersionSchema,
  admin_config_version_make_current: S.configVersionSchema,
  admin_config_versions: page(S.configVersionSchema),
  admin_job: S.adminJobDetailSchema,
  admin_job_approve: S.decisionResultSchema,
  admin_job_approve_manual: S.decisionResultSchema,
  admin_job_edit: S.jobEditResultSchema,
  admin_job_manual: S.adminJobDetailSchema,
  admin_job_recalculate: S.recalculateJobSchema,
  admin_job_series: S.seriesSchema,
  admin_job_trace: S.traceLinkSchema,
  admin_operation: S.operationSchema,
  admin_player: S.adminPlayerSchema,
  admin_player_token_issue: S.tokenIssueSchema,
  admin_player_token_revoke: S.tokenRevokedSchema,
  admin_player_update: S.adminPlayerSchema,
  admin_recalculations: S.recalculationStartedSchema,
  admin_recalculations_dry_run: S.recalculationDryRunSchema,
  admin_release_create: S.releaseSchema,
  admin_releases: page(S.releaseSchema),
  admin_review_queue: page(S.reviewQueueItemSchema),
  admin_review_queue_count: S.reviewQueueCountSchema,
  admin_revocation_cancel: S.revocationSchema,
  admin_revocation_create: S.revocationSchema,
  admin_revocations: page(S.revocationSchema),
  admin_truckersmp_flags: page(S.truckersmpFlagSchema),
  error_invalid_transition: S.errorBodySchema,
  error_unauthorized: S.errorBodySchema,
  error_validation: S.errorBodySchema,
  error_validation_manual: S.errorBodySchema,
  player_evidence_upload: S.evidenceUploadSchema,
  player_job_evidence: S.jobEvidenceSchema,
  player_manual_job_submit: S.jobDetailSchema,
  public_job_manual: S.jobDetailSchema,
  public_player_jobs_all: page(S.jobSummarySchema),
  player_rename: S.playerProfileSchema,
  player_token_issue: S.tokenIssueSchema,
  player_token_revoke: S.tokenRevokedSchema,
  player_token_status: S.tokenMetaSchema,
  public_job: S.jobDetailSchema,
  public_job_pending: S.jobDetailSchema,
  public_leaderboard: S.leaderboardSchema,
  public_leaderboard_by_fuel: S.leaderboardSchema,
  public_player_history: S.playerHistorySchema,
  public_job_series: S.seriesSchema,
  public_client: S.publicClientSchema,
  player_client_download: S.clientDownloadSchema,
  admin_release_offer: S.releaseSchema,
  public_player: S.playerProfileSchema,
  public_player_jobs: page(S.jobSummarySchema),
  public_player_stats: S.gameStatsResponseSchema,
  public_player_unlinked: S.playerProfileSchema,
};

const ROUTES = ['admin_job_route', 'public_job_route'];

/** Endpoints the bot doesn't call (yet), so it has no schema for them. */
const NOT_CALLED = ['admin_backup_create', 'admin_release_create_update'];

const WEBHOOKS: Record<string, z.ZodType> = {
  'job.scored': E.jobScoredSchema,
  'job.needs_review': E.jobNeedsReviewSchema,
  'job.discarded': E.jobDiscardedSchema,
  'player.notification': E.playerNotificationSchema,
  'version.revocation_scheduled': E.revocationScheduledSchema,
  'version.revocation_cancelled': E.revocationCancelledSchema,
  'operation.completed': E.operationCompletedSchema,
};

const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
const load = (name: string): unknown => JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8'));
const issues = (r: { success: boolean; error?: { issues: unknown } }) => (r.success ? null : JSON.stringify(r.error?.issues));

describe('server contract examples', () => {
  it('every example file is covered by this test', () => {
    const covered = new Set([...Object.keys(RESPONSES), ...ROUTES, ...NOT_CALLED]);
    const unmapped = files.map((f) => f.replace(/\.json$/, '')).filter((n) => !n.startsWith('webhook_') && !covered.has(n));
    expect(unmapped).toEqual([]);
    expect(files.length).toBeGreaterThan(50);
  });

  it.each(Object.keys(RESPONSES))('%s parses', (name) => {
    expect(issues(RESPONSES[name]!.safeParse(load(name)))).toBeNull();
  });

  it.each(ROUTES)('%s parses, with only segment kinds and scale classes the bot knows', (name) => {
    const r = S.serverRouteSchema.safeParse(load(name));
    expect(issues(r)).toBeNull();
    const props = r.data!.features.map((f) => f.properties);
    expect(props.length).toBeGreaterThan(0);
    // Open enums turn new values into 'other'; a new kind must be handled on purpose.
    expect(props.filter((p) => p.segment === 'other' || p.scale_class === 'other' || p.status === 'other')).toEqual([]);
  });

  it.each(files.filter((f) => f.startsWith('webhook_')))('%s parses (envelope and data)', (file) => {
    const json = load(file.replace(/\.json$/, '')) as { type: string; data: unknown };
    expect(issues(E.webhookEnvelopeSchema.safeParse(json))).toBeNull();
    const schema = WEBHOOKS[json.type];
    expect(schema, `no schema for ${json.type}`).toBeDefined();
    expect(issues(schema!.safeParse(json.data))).toBeNull();
  });

  it('every webhook type the bot handles has an example', () => {
    const types = files.filter((f) => f.startsWith('webhook_')).map((f) => (load(f.replace(/\.json$/, '')) as { type: string }).type);
    expect(new Set(types)).toEqual(new Set(Object.keys(WEBHOOKS)));
  });
});
