export class QueueFullError extends Error {
  override name = 'QueueFullError';
}

/** Runs at most `concurrency` jobs at once; beyond `queueLimit` waiting jobs, new ones are refused. */
export class Limiter {
  private readonly concurrency: number;
  private readonly queueLimit: number;
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(concurrency: number, queueLimit: number) {
    this.concurrency = concurrency;
    this.queueLimit = queueLimit;
  }

  async run<T>(job: () => Promise<T>): Promise<T> {
    if (this.running >= this.concurrency) {
      if (this.waiting.length >= this.queueLimit) throw new QueueFullError('renderer is busy');
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.running++;
    try {
      return await job();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }
}
