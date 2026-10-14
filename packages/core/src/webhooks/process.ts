import type { z } from 'zod';
import { DiscordApiError } from '../discord/rest.ts';
import {
  RetryableError,
  type DiscordSender,
  type ProcessResult,
  type QueueMessage,
} from '../interactions/types.ts';
import type { Logger } from '../log.ts';
import type { Clock, DedupeStore, JobVersionStore, NoticeStore, WorkQueue } from '../ports.ts';
import {
  jobDiscardedSchema,
  jobNeedsReviewSchema,
  jobScoredSchema,
  operationCompletedSchema,
  playerNotificationSchema,
  revocationCancelledSchema,
  revocationScheduledSchema,
  type WebhookEnvelope,
} from './events.ts';
import { notificationDm, revocationCancelledDm, revocationDm, type DmContent } from './messages.ts';

// Queue-side handling of server webhooks. Delivery is at least once and
// unordered (server WEBHOOKS §3): events are deduplicated on event_id, DMs on
// (event, recipient), and job events older than one already seen are skipped.

/** Longer than the server's 72 h retry window. */
const EVENT_DEDUPE_TTL_S = 7 * 24 * 3600;
/** Discord "Unknown User". */
const UNKNOWN_USER = 10013;

export interface EventDeps {
  discord: DiscordSender;
  notices: NoticeStore;
  dedupe: DedupeStore;
  jobVersions: JobVersionStore;
  queue: WorkQueue<QueueMessage>;
  clock: Clock;
  logger: Logger;
  noticeTtlDays: number;
}

type WebhookMessage = Extract<QueueMessage, { type: 'webhook' }>;
type PlayerDmMessage = Extract<QueueMessage, { type: 'player-dm' }>;

export async function processWebhookEvent(msg: WebhookMessage, deps: EventDeps): Promise<ProcessResult> {
  const { event } = msg;
  const key = `evt:${event.event_id}:${msg.chunk}`;
  if (!(await deps.dedupe.claim(key, EVENT_DEDUPE_TTL_S))) {
    deps.logger.info('duplicate webhook ignored', { type: event.type, eventId: event.event_id });
    return { status: 'done' };
  }
  try {
    await handleEvent(event, deps);
    return { status: 'done' };
  } catch (err) {
    await deps.dedupe.release(key);
    return failure(err, deps.logger, { type: event.type, eventId: event.event_id });
  }
}

async function handleEvent(event: WebhookEnvelope, deps: EventDeps): Promise<void> {
  const log = { type: event.type, eventId: event.event_id };
  switch (event.type) {
    case 'player.notification': {
      const n = parse(playerNotificationSchema, event, deps.logger);
      if (!n) return;
      await deliverDm(n.recipient.discord_user_id, notificationDm(n), `${event.event_id}`, deps);
      return;
    }
    case 'version.revocation_scheduled': {
      const r = parse(revocationScheduledSchema, event, deps.logger);
      if (r) await fanOut(`${r.revocation_id}:scheduled`, r.recipients, revocationDm(r), deps, { ...log, part: r.part });
      return;
    }
    case 'version.revocation_cancelled': {
      const r = parse(revocationCancelledSchema, event, deps.logger);
      if (r) await fanOut(`${r.revocation_id}:cancelled`, r.recipients, revocationCancelledDm(r), deps, { ...log, part: r.part });
      return;
    }
    case 'job.needs_review':
    case 'job.scored':
    case 'job.discarded': {
      const schema =
        event.type === 'job.needs_review' ? jobNeedsReviewSchema : event.type === 'job.scored' ? jobScoredSchema : jobDiscardedSchema;
      const job = parse(schema, event, deps.logger);
      if (!job) return;
      // Stage 5 posts and updates review-queue messages here. Until then the
      // version is recorded so ordering already works when that lands. Note
      // for stage 5: advance only after the Discord update succeeded, or a
      // retry would be skipped as stale.
      const fresh = await deps.jobVersions.advance(job.job_id, job.job_version);
      deps.logger.info(fresh ? 'job event received' : 'stale job event ignored', {
        ...log,
        jobId: job.job_id,
        jobVersion: job.job_version,
      });
      return;
    }
    case 'operation.completed': {
      const op = parse(operationCompletedSchema, event, deps.logger);
      if (op) deps.logger.info('operation completed', { ...log, operationId: op.operation_id, status: op.status });
      return;
    }
    default:
      // New event types may appear without notice (API_CONVENTIONS §1).
      deps.logger.info('unhandled webhook event type', log);
  }
}

/**
 * One queue message per player, so Discord's rate limits apply per DM and one
 * closed DM inbox doesn't hold up the rest.
 */
async function fanOut(
  keyPrefix: string,
  recipients: readonly string[],
  content: DmContent,
  deps: EventDeps,
  log: Record<string, unknown>,
): Promise<void> {
  const unique = [...new Set(recipients)];
  await deps.queue.sendBatch(
    unique.map((userId) => ({ type: 'player-dm' as const, key: `${keyPrefix}:${userId}`, userId, ...content })),
  );
  deps.logger.info('DMs queued', { ...log, recipients: unique.length });
}

export async function processPlayerDm(msg: PlayerDmMessage, deps: EventDeps): Promise<ProcessResult> {
  const key = `dm:${msg.key}`;
  if (!(await deps.dedupe.claim(key, EVENT_DEDUPE_TTL_S))) return { status: 'done' };
  try {
    await deliverDm(msg.userId, { message: msg.message, notice: msg.notice }, msg.key, deps);
    return { status: 'done' };
  } catch (err) {
    await deps.dedupe.release(key);
    return failure(err, deps.logger, { kind: msg.notice.kind });
  }
}

export type DmOutcome = 'dm' | 'notice' | 'dropped';

/**
 * DMs a player. If Discord won't deliver it (DMs closed, no shared server),
 * the text is kept for `/notices` instead: only that user can ever read it,
 * and only ephemerally. Retryable Discord failures are thrown.
 */
export async function deliverDm(userId: string, content: DmContent, noticeId: string, deps: EventDeps): Promise<DmOutcome> {
  try {
    await deps.discord.sendDirectMessage(userId, { ...content.message, allowed_mentions: { parse: [] } });
    return 'dm';
  } catch (err) {
    if (!(err instanceof DiscordApiError) || err.retryable) throw err;
    if (err.code === UNKNOWN_USER) {
      deps.logger.warn('DM recipient is not a Discord user', { kind: content.notice.kind });
      return 'dropped';
    }
    const now = deps.clock.now();
    await deps.notices.add(userId, {
      id: noticeId,
      kind: content.notice.kind,
      text: content.notice.text,
      createdAt: now,
      expiresAt: now + deps.noticeTtlDays * 24 * 3600_000,
    });
    deps.logger.info('DM not deliverable; stored as a notice', { kind: content.notice.kind, discordCode: err.code });
    return 'notice';
  }
}

function parse<S extends z.ZodType>(schema: S, event: WebhookEnvelope, logger: Logger): z.output<S> | null {
  const result = schema.safeParse(event.data);
  if (result.success) return result.data;
  // Field paths only: payloads hold Discord IDs and player-facing text.
  logger.error('webhook payload does not match the contract', {
    type: event.type,
    eventId: event.event_id,
    fields: result.error.issues.slice(0, 5).map((i) => i.path.join('.')),
  });
  return null;
}

function failure(err: unknown, logger: Logger, context: Record<string, unknown>): ProcessResult {
  if (err instanceof RetryableError) return { status: 'retry', delaySeconds: err.delaySeconds };
  if (err instanceof DiscordApiError && err.retryable) {
    return { status: 'retry', delaySeconds: Math.max(1, Math.ceil(err.retryAfterSeconds ?? 5)) };
  }
  // Unexpected: retry a few times (the queue gives up after max_retries).
  logger.error('webhook processing failed', { ...context, err });
  return { status: 'retry', delaySeconds: 30 };
}

