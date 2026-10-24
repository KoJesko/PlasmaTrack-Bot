import { afterEach, describe, expect, it, vi } from 'vitest';
import { InlineTaskQueue } from '../src/interactions/inline.ts';
import type { ProcessResult, QueueMessage } from '../src/interactions/types.ts';
import { MemoryWorkQueue } from '../src/memory.ts';
import { captureLogger } from './helpers.ts';

const ref = { id: 'i1', applicationId: 'app', token: 'tok', userId: 'u1', guildId: 'g1', receivedAt: 0 };
const task: QueueMessage = { type: 'interaction-task', task: { name: 'leaderboard.show', input: {} }, interaction: ref, noticeHint: false };
const hint: QueueMessage = { type: 'notice-hint', interaction: ref };
const webhook = { type: 'webhook', backend: 'production', event: {}, chunk: 0 } as unknown as QueueMessage;

function setup(run: (m: QueueMessage) => Promise<ProcessResult>, budgetMs?: number) {
  const queue = new MemoryWorkQueue<QueueMessage>();
  const work: Promise<unknown>[] = [];
  const lost: QueueMessage[] = [];
  const { logger, lines } = captureLogger();
  const inline = new InlineTaskQueue({
    queue,
    waitUntil: (p) => void work.push(p),
    run,
    logger,
    onLost: async (m) => void lost.push(m),
    ...(budgetMs ? { budgetMs } : {}),
  });
  return { inline, queue, work, lost, lines, settle: () => Promise.all(work) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('InlineTaskQueue', () => {
  it('runs a command’s task here, after the response, without the queue', async () => {
    const ran: QueueMessage[] = [];
    const s = setup(async (m) => (ran.push(m), { status: 'done' }));
    await s.inline.send(task);
    await s.inline.send(hint);
    await s.settle();
    expect(ran).toEqual([task, hint]);
    expect(s.queue.take()).toEqual([]);
  });

  it('send returns before the task finishes, so the response is never held up', async () => {
    let finish!: () => void;
    const s = setup(() => new Promise<ProcessResult>((ok) => (finish = () => ok({ status: 'done' }))));
    await s.inline.send(task);
    expect(s.work).toHaveLength(1);
    finish();
    await s.settle();
  });

  it('hands a retry to the queue with its delay', async () => {
    const s = setup(async () => ({ status: 'retry', delaySeconds: 7 }));
    await s.inline.send(task);
    await s.settle();
    expect(s.queue.items).toEqual([{ item: task, delaySeconds: 7 }]);
  });

  it('hands a crashed task to the queue', async () => {
    const s = setup(async () => {
      throw new Error('boom');
    });
    await s.inline.send(task);
    await s.settle();
    expect(s.queue.take()).toEqual([task]);
    expect(s.lines.some((l) => l.level === 'error' && l.line.includes('queue message crashed'))).toBe(true);
  });

  it('hands a task over its budget to the queue', async () => {
    vi.useFakeTimers();
    const s = setup(() => new Promise<ProcessResult>(() => {}), 20_000);
    await s.inline.send(task);
    await vi.advanceTimersByTimeAsync(20_000);
    await s.settle();
    expect(s.queue.take()).toEqual([task]);
  });

  it('tells the user when the retry can’t be queued either', async () => {
    const s = setup(async () => ({ status: 'retry', delaySeconds: 3 }));
    s.queue.send = () => Promise.reject(new Error('queue down'));
    await s.inline.send(task);
    await s.settle();
    expect(s.lost).toEqual([task]);
  });

  it('sends webhooks, delayed messages and batches straight to the queue', async () => {
    const ran: QueueMessage[] = [];
    const s = setup(async (m) => (ran.push(m), { status: 'done' }));
    await s.inline.send(webhook);
    await s.inline.send(task, { delaySeconds: 5 });
    await s.inline.sendBatch([hint]);
    expect(ran).toEqual([]);
    expect(s.queue.take()).toEqual([webhook, task, hint]);
  });
});
