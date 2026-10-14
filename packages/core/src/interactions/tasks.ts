import { MessageFlags } from '../discord/constants.ts';
import { DiscordApiError } from '../discord/rest.ts';
import { processPlayerDm, processWebhookEvent, type EventDeps } from '../webhooks/process.ts';
import {
  RetryableError,
  UserFacingError,
  type InteractionRef,
  type ProcessResult,
  type QueueMessage,
  type TaskDefinition,
  type TaskDeps,
} from './types.ts';

/** Discord interaction tokens are valid for 15 minutes; stop a little before. */
export const INTERACTION_TOKEN_TTL_MS = 15 * 60_000;
const TOKEN_SAFETY_MS = 30_000;

export const GENERIC_FAILURE = 'Sorry, something went wrong. Please try again later.';

/** Everything the queue consumer needs. */
export type ConsumerDeps = TaskDeps & EventDeps;

/** Runs one queued message. The host's queue consumer maps the result to ack/retry. */
export async function processQueueMessage(
  message: QueueMessage,
  tasks: readonly TaskDefinition[],
  deps: ConsumerDeps,
): Promise<ProcessResult> {
  switch (message.type) {
    case 'webhook':
      return processWebhookEvent(message, deps);
    case 'player-dm':
      return processPlayerDm(message, deps);
    default:
      return processInteractionMessage(message, tasks, deps);
  }
}

async function processInteractionMessage(
  message: Extract<QueueMessage, { type: 'interaction-task' | 'notice-hint' }>,
  tasks: readonly TaskDefinition[],
  deps: TaskDeps,
): Promise<ProcessResult> {
  const ref = message.interaction;
  if (deps.clock.now() - ref.receivedAt > INTERACTION_TOKEN_TTL_MS - TOKEN_SAFETY_MS) {
    deps.logger.warn('interaction token expired before the task ran', { type: message.type, interactionId: ref.id });
    return { status: 'dropped', reason: 'interaction token expired' };
  }

  if (message.type === 'notice-hint') {
    await sendNoticeHint(ref, deps);
    return { status: 'done' };
  }

  const task = tasks.find((t) => t.name === message.task.name);
  if (!task) {
    await bestEffortEdit(ref, GENERIC_FAILURE, deps);
    deps.logger.error('unknown task', { task: message.task.name });
    return { status: 'dropped', reason: 'unknown task' };
  }

  try {
    const output = await task.run(message.task.input, { interaction: ref, deps });
    await deps.discord.editOriginal(ref.token, output.message, output.files ?? []);
    await output.afterDelivered?.();
  } catch (err) {
    if (err instanceof RetryableError) return { status: 'retry', delaySeconds: err.delaySeconds };
    if (err instanceof DiscordApiError && err.retryable) {
      return { status: 'retry', delaySeconds: Math.max(1, Math.ceil(err.retryAfterSeconds ?? 5)) };
    }
    if (err instanceof UserFacingError) {
      await bestEffortEdit(ref, err.message, deps);
      return { status: 'done' };
    }
    deps.logger.error('task failed', { task: task.name, err });
    await bestEffortEdit(ref, GENERIC_FAILURE, deps);
    return { status: 'done' };
  }

  if (message.noticeHint && task.name !== NOTICES_TASK) await sendNoticeHint(ref, deps);
  return { status: 'done' };
}

export const NOTICES_TASK = 'notices.list';

/**
 * Tells a player, privately, that they have notices the bot could not DM.
 * Best effort: a failure here never fails the command.
 */
export async function sendNoticeHint(ref: InteractionRef, deps: TaskDeps): Promise<void> {
  try {
    const count = await deps.notices.countUnread(ref.userId);
    if (count === 0) return;
    await deps.discord.followup(ref.token, {
      content: `You have ${count} unread notice${count === 1 ? '' : 's'} that couldn't be sent as a DM. Use \`/notices\` to read ${count === 1 ? 'it' : 'them'} (only you can see this).`,
      flags: MessageFlags.Ephemeral,
    });
  } catch (err) {
    deps.logger.warn('notice hint failed', { err });
  }
}

async function bestEffortEdit(ref: InteractionRef, content: string, deps: TaskDeps): Promise<void> {
  try {
    await deps.discord.editOriginal(ref.token, { content, embeds: [], components: [] });
  } catch (err) {
    deps.logger.warn('could not report failure to the user', { err });
  }
}
