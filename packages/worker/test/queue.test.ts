import { createExecutionContext, createMessageBatch, env, getQueueResult } from 'cloudflare:test';
import type { QueueMessage } from '@plasmatrack/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { D1NoticeStore } from '../src/adapters.ts';
import worker from '../src/index.ts';
import { INTERACTION_TOKEN, USER_A, USER_B } from './helpers.ts';

function taskMessage(name: string, userId = USER_A): QueueMessage {
  return {
    type: 'interaction-task',
    task: { name, input: null },
    interaction: { id: '1', applicationId: '100000000000000001', token: INTERACTION_TOKEN, userId, receivedAt: Date.now() },
    noticeHint: true,
  };
}

async function runBatch(messages: QueueMessage[]) {
  const batch = createMessageBatch<QueueMessage>(
    'plasmatrack-work-test',
    messages.map((body, i) => ({ id: `m${i}`, timestamp: new Date(), attempts: 1, body })),
  );
  const retries = batch.messages.map((m) => vi.spyOn(m, 'retry'));
  const ctx = createExecutionContext();
  await worker.queue(batch, env, ctx);
  return { result: await getQueueResult(batch, ctx), retries };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('queue consumer', () => {
  it('runs /notices: edits the deferred reply ephemerally and marks only that user’s notices read', async () => {
    const store = new D1NoticeStore(env.DB);
    const now = Date.now();
    await store.add(USER_A, { id: 'n1', kind: 'speed_penalty', text: 'Speed penalty activated on job 7', createdAt: now, expiresAt: now + 60_000 });
    await store.add(USER_B, { id: 'n1', kind: 'invalid_delivery', text: 'B only', createdAt: now, expiresAt: now + 60_000 });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ id: 'msg' }));
    const { result } = await runBatch([taskMessage('notices.list')]);

    expect(result.explicitAcks).toEqual(['m0']);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(`https://discord.com/api/v10/webhooks/100000000000000001/${INTERACTION_TOKEN}/messages/@original`);
    const body = JSON.parse(init.body as string);
    expect(body.flags & 64).toBe(64);
    expect(JSON.stringify(body)).toContain('Speed penalty activated on job 7');
    expect(JSON.stringify(body)).not.toContain('B only');
    expect(await store.countUnread(USER_A)).toBe(0);
    expect(await store.countUnread(USER_B)).toBe(1);
  });

  it('retries a message when Discord rate-limits, using its retry_after', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json({ message: 'rate limited', retry_after: 2.5 }, { status: 429 }),
    );
    const { result, retries } = await runBatch([taskMessage('notices.list')]);
    expect(result.retryMessages.map((m: { msgId: string }) => m.msgId)).toEqual(['m0']);
    expect(retries[0]).toHaveBeenCalledWith({ delaySeconds: 3 });
    expect(result.explicitAcks).toEqual([]);
  });
});
