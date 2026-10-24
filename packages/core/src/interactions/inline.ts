import type { Logger } from '../log.ts';
import type { WorkQueue } from '../ports.ts';
import type { ProcessResult, QueueMessage } from './types.ts';

// Runs a command's deferred work right after its first response, in the same
// request, instead of waiting for the queue to deliver it: the queue can take
// seconds (2026-10-24: up to 20 s), the work itself about one. The queue stays
// the fallback: a task asking for a retry, running over its budget, or
// crashing goes there, with the same retries as before. Webhook work and
// delayed messages go straight to the queue; nobody is waiting on them.

/** Well inside the 30 s a Worker may keep working after its response. */
export const INLINE_BUDGET_MS = 20_000;
/** Same as the queue consumer's wait after a crash. */
const CRASH_RETRY_DELAY_S = 10;

export interface InlineTaskQueueOptions {
  /** The real queue, for everything that isn't run here. */
  queue: WorkQueue<QueueMessage>;
  /** Keeps the request alive for work after the response (`ctx.waitUntil`). */
  waitUntil: (work: Promise<unknown>) => void;
  /** Runs one message, as the queue consumer would on its first delivery. */
  run: (message: QueueMessage) => Promise<ProcessResult>;
  logger: Logger;
  /** A retry that couldn't be queued: tell the user rather than leave them on "thinking…". */
  onLost?: (message: QueueMessage) => Promise<void>;
  budgetMs?: number;
}

export class InlineTaskQueue implements WorkQueue<QueueMessage> {
  private readonly options: InlineTaskQueueOptions;

  constructor(options: InlineTaskQueueOptions) {
    this.options = options;
  }

  async send(message: QueueMessage, options?: { delaySeconds?: number }): Promise<void> {
    const interactive = message.type === 'interaction-task' || message.type === 'notice-hint';
    if (!interactive || options?.delaySeconds) return this.options.queue.send(message, options);
    this.options.waitUntil(this.runHere(message));
  }

  sendBatch(items: QueueMessage[]): Promise<void> {
    return this.options.queue.sendBatch(items);
  }

  private async runHere(message: QueueMessage): Promise<void> {
    const { queue, run, logger } = this.options;
    const log = describe(message);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const overBudget = new Promise<'over'>((ok) => {
      timer = setTimeout(() => ok('over'), this.options.budgetMs ?? INLINE_BUDGET_MS);
    });
    let handOff: { delaySeconds?: number } | null = null;
    try {
      const result = await Promise.race([run(message), overBudget]);
      if (result === 'over') {
        logger.warn('task over its inline budget; handed to the queue', log);
        handOff = {};
      } else if (result.status === 'retry') {
        handOff = { delaySeconds: result.delaySeconds };
      }
    } catch (err) {
      logger.error('queue message crashed', { ...log, err });
      handOff = { delaySeconds: CRASH_RETRY_DELAY_S };
    } finally {
      clearTimeout(timer);
    }
    if (!handOff) return;
    try {
      await queue.send(message, handOff.delaySeconds ? { delaySeconds: handOff.delaySeconds } : undefined);
    } catch (err) {
      logger.error('retry could not be queued', { ...log, err });
      await this.options.onLost?.(message).catch((e: unknown) => logger.error('lost task not reported', { ...log, err: e }));
    }
  }
}

function describe(message: QueueMessage): Record<string, unknown> {
  return message.type === 'interaction-task'
    ? { task: message.task.name, interactionId: message.interaction.id }
    : { type: message.type };
}
