import type { z } from 'zod';
import { DiscordApiError } from '../discord/rest.ts';
import {
  RetryableError,
  type DiscordSender,
  type ProcessResult,
  type QueueMessage,
} from '../interactions/types.ts';
import type { Logger } from '../log.ts';
import type { Clock, DedupeStore, JobVersionStore, NoticeStore, ReviewPostStore, WorkQueue } from '../ports.ts';
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
import { needsReviewPost, operationPost, resolvedPost } from './review-posts.ts';
import type { OutgoingMessage } from '../discord/rest.ts';

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
  reviewPosts: ReviewPostStore;
  /** Review channels of every Discord server that uses this backend. */
  reviewChannels(backend: string): string[];
}

type WebhookMessage = Extract<QueueMessage, { type: 'webhook' }>;
type PlayerDmMessage = Extract<QueueMessage, { type: 'player-dm' }>;

export async function processWebhookEvent(msg: WebhookMessage, deps: EventDeps): Promise<ProcessResult> {
  const { event, backend } = msg;
  const key = `evt:${backend}:${event.event_id}:${msg.chunk}`;
  if (!(await deps.dedupe.claim(key, EVENT_DEDUPE_TTL_S))) {
    deps.logger.info('duplicate webhook ignored', { type: event.type, eventId: event.event_id });
    return { status: 'done' };
  }
  try {
    await handleEvent(backend, event, deps);
    return { status: 'done' };
  } catch (err) {
    await deps.dedupe.release(key);
    return failure(err, deps.logger, { type: event.type, eventId: event.event_id });
  }
}

async function handleEvent(backend: string, event: WebhookEnvelope, deps: EventDeps): Promise<void> {
  const log = { backend, type: event.type, eventId: event.event_id };
  switch (event.type) {
    case 'player.notification': {
      const n = parse(playerNotificationSchema, event, deps.logger);
      if (!n) return;
      await deliverDm(backend, n.recipient.discord_user_id, notificationDm(n), event.event_id, deps);
      return;
    }
    case 'version.revocation_scheduled': {
      const r = parse(revocationScheduledSchema, event, deps.logger);
      if (r) await fanOut(backend, `${r.revocation_id}:scheduled`, r.recipients, revocationDm(r), deps, { ...log, part: r.part });
      return;
    }
    case 'version.revocation_cancelled': {
      const r = parse(revocationCancelledSchema, event, deps.logger);
      if (r) await fanOut(backend, `${r.revocation_id}:cancelled`, r.recipients, revocationCancelledDm(r), deps, { ...log, part: r.part });
      return;
    }
    case 'job.needs_review': {
      const job = parse(jobNeedsReviewSchema, event, deps.logger);
      if (job) await updateReviewPosts(backend, job.job_id, job.job_version, needsReviewPost(job), true, deps, log);
      return;
    }
    case 'job.scored': {
      const job = parse(jobScoredSchema, event, deps.logger);
      if (job) await updateReviewPosts(backend, job.job_id, job.job_version, resolvedPost(job), false, deps, log);
      return;
    }
    case 'job.discarded': {
      const job = parse(jobDiscardedSchema, event, deps.logger);
      if (job) await updateReviewPosts(backend, job.job_id, job.job_version, resolvedPost(job), false, deps, log);
      return;
    }
    case 'operation.completed': {
      const op = parse(operationCompletedSchema, event, deps.logger);
      if (!op) return;
      for (const channel of deps.reviewChannels(backend)) await deps.discord.postChannelMessage(channel, operationPost(op));
      deps.logger.info('operation completed', { ...log, operationId: op.operation_id, status: op.status });
      return;
    }
    default:
      // New event types may appear without notice (API_CONVENTIONS §1).
      deps.logger.info('unhandled webhook event type', log);
  }
}

/**
 * Posts or edits the job's message in every review channel of the backend's
 * Discord servers. A job that enters review gets a post (or its old post is
 * edited if it was posted before); a decision only edits existing posts. The
 * job version is recorded after Discord accepted every update, so a failed
 * update is retried rather than skipped as stale (server WEBHOOKS §3).
 */
async function updateReviewPosts(
  backend: string,
  jobId: string,
  version: number,
  message: OutgoingMessage,
  create: boolean,
  deps: EventDeps,
  log: Record<string, unknown>,
): Promise<void> {
  const key = `${backend}:${jobId}`;
  const current = await deps.jobVersions.current(key);
  if (current !== null && current >= version) {
    deps.logger.info('stale job event ignored', { ...log, jobId, jobVersion: version });
    return;
  }
  const existing = await deps.reviewPosts.find(backend, jobId);
  for (const channelId of deps.reviewChannels(backend)) {
    const post = existing.find((p) => p.channelId === channelId);
    if (post) {
      try {
        await deps.discord.editChannelMessage(channelId, post.messageId, message);
        continue;
      } catch (err) {
        // The post was deleted by hand: post again if the job is (back) in review.
        if (!(err instanceof DiscordApiError) || err.retryable || err.status !== 404 || !create) throw err;
      }
    } else if (!create) {
      continue;
    }
    const messageId = await deps.discord.postChannelMessage(channelId, message);
    await deps.reviewPosts.put({ backend, jobId, channelId, messageId });
  }
  await deps.jobVersions.advance(key, version);
  deps.logger.info('review posts updated', { ...log, jobId, jobVersion: version });
}

/**
 * One queue message per player, so Discord's rate limits apply per DM and one
 * closed DM inbox doesn't hold up the rest.
 */
async function fanOut(
  backend: string,
  keyPrefix: string,
  recipients: readonly string[],
  content: DmContent,
  deps: EventDeps,
  log: Record<string, unknown>,
): Promise<void> {
  const unique = [...new Set(recipients)];
  await deps.queue.sendBatch(
    unique.map((userId) => ({ type: 'player-dm' as const, backend, key: `${keyPrefix}:${userId}`, userId, ...content })),
  );
  deps.logger.info('DMs queued', { ...log, recipients: unique.length });
}

export async function processPlayerDm(msg: PlayerDmMessage, deps: EventDeps): Promise<ProcessResult> {
  const key = `dm:${msg.backend}:${msg.key}`;
  if (!(await deps.dedupe.claim(key, EVENT_DEDUPE_TTL_S))) return { status: 'done' };
  try {
    await deliverDm(msg.backend, msg.userId, { message: msg.message, notice: msg.notice }, msg.key, deps);
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
export async function deliverDm(
  backend: string,
  userId: string,
  content: DmContent,
  noticeId: string,
  deps: EventDeps,
): Promise<DmOutcome> {
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
      // Prefixed: IDs from different backends must never collide.
      id: `${backend}:${noticeId}`,
      backend,
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

