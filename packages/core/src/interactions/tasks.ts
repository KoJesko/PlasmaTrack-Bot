import { MessageFlags } from '../discord/constants.ts';
import { DiscordApiError } from '../discord/rest.ts';
import type { PlasmaTrackApi } from '../api/client.ts';
import { processPlayerDm, processWebhookEvent, type EventDeps } from '../webhooks/process.ts';
import { withReference } from './router.ts';
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
/** Shown when a task still can't finish on its last try, or before the interaction token runs out. */
export const GAVE_UP = 'The PlasmaTrack server or Discord is busy right now, so this couldn’t finish. Please try again in a few minutes.';

/** Which try this is. Hosts without retry counts can leave it out (no limit). */
export interface Delivery {
  /** 1 on the first delivery. */
  attempt: number;
  maxAttempts: number;
}

/** Which backend serves a Discord server; null outside a configured server. */
export interface BackendResolver {
  forGuild(guildId: string | undefined): { name: string; api: PlasmaTrackApi | null } | null;
  byName(name: string): PlasmaTrackApi | null;
}

/** Everything the queue consumer needs. `api` and `backend` are filled in per interaction. */
export type ConsumerDeps = Omit<TaskDeps, 'api' | 'backend' | 'apiByName'> & EventDeps & { backends: BackendResolver };

/** Runs one queued message. The host's queue consumer maps the result to ack/retry. */
export async function processQueueMessage(
  message: QueueMessage,
  tasks: readonly TaskDefinition[],
  deps: ConsumerDeps,
  delivery?: Delivery,
): Promise<ProcessResult> {
  switch (message.type) {
    case 'webhook':
      return processWebhookEvent(message, deps);
    case 'player-dm':
      return processPlayerDm(message, deps);
    default: {
      const backend = deps.backends.forGuild(message.interaction.guildId);
      return processInteractionMessage(message, tasks, {
        ...deps,
        api: backend?.api ?? null,
        backend: backend?.name ?? null,
        apiByName: (name) => deps.backends.byName(name),
      }, delivery);
    }
  }
}

async function processInteractionMessage(
  message: Extract<QueueMessage, { type: 'interaction-task' | 'notice-hint' }>,
  tasks: readonly TaskDefinition[],
  deps: TaskDeps,
  delivery?: Delivery,
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
    await bestEffortEdit(ref, withReference(GENERIC_FAILURE, ref.id), deps);
    deps.logger.error('unknown task', { task: message.task.name, interactionId: ref.id });
    return { status: 'dropped', reason: 'unknown task' };
  }

  try {
    const output = await task.run(message.task.input, { interaction: ref, deps });
    await deps.discord.editOriginal(ref.token, output.message, output.files ?? []);
    await output.afterDelivered?.();
  } catch (err) {
    if (err instanceof RetryableError) return retryOrGiveUp(err.delaySeconds, task.name, ref, deps, delivery);
    if (err instanceof DiscordApiError && err.retryable) {
      return retryOrGiveUp(Math.max(1, Math.ceil(err.retryAfterSeconds ?? 5)), task.name, ref, deps, delivery);
    }
    if (err instanceof UserFacingError) {
      await bestEffortEdit(ref, err.message, deps);
      return { status: 'done' };
    }
    deps.logger.error('task failed', { task: task.name, interactionId: ref.id, err });
    await bestEffortEdit(ref, withReference(GENERIC_FAILURE, ref.id), deps);
    return { status: 'done' };
  }

  if (message.noticeHint && task.name !== NOTICES_TASK) await sendNoticeHint(ref, deps);
  return { status: 'done' };
}

/**
 * A retry is pointless on the last try, or when it would run after the
 * interaction token expires: the user would be left on "thinking…". Tell them instead.
 */
async function retryOrGiveUp(
  delaySeconds: number,
  task: string,
  ref: InteractionRef,
  deps: TaskDeps,
  delivery: Delivery | undefined,
): Promise<ProcessResult> {
  const lastTry = delivery ? delivery.attempt >= delivery.maxAttempts : false;
  const tooLate = deps.clock.now() + delaySeconds * 1000 > ref.receivedAt + INTERACTION_TOKEN_TTL_MS - TOKEN_SAFETY_MS;
  if (!lastTry && !tooLate) return { status: 'retry', delaySeconds };
  deps.logger.warn('task gave up', { task, interactionId: ref.id, attempt: delivery?.attempt, lastTry, tooLate });
  await bestEffortEdit(ref, withReference(GAVE_UP, ref.id), deps);
  return { status: 'done' };
}

/** Safe fields to log for a message (never tokens or message bodies), e.g. from the dead-letter queue. */
export function describeQueueMessage(message: QueueMessage): Record<string, unknown> {
  switch (message.type) {
    case 'webhook':
      return { type: message.type, backend: message.backend, event: message.event.type, eventId: message.event.event_id };
    case 'player-dm':
      return { type: message.type, backend: message.backend, key: message.key };
    case 'interaction-task':
      return { type: message.type, task: message.task.name, interactionId: message.interaction.id, guildId: message.interaction.guildId };
    case 'notice-hint':
      return { type: message.type, interactionId: message.interaction.id };
    default:
      return { type: (message as { type?: unknown }).type ?? 'unknown' };
  }
}

export const NOTICES_TASK = 'notices.list';

/**
 * Tells a player, privately, that they have notices the bot could not DM.
 * Best effort: a failure here never fails the command.
 */
export async function sendNoticeHint(ref: InteractionRef, deps: TaskDeps): Promise<void> {
  if (!deps.backend) return;
  try {
    const count = await deps.notices.countUnread(ref.userId, deps.backend);
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
