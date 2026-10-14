import { describe, expect, it } from 'vitest';
import { MemoryDedupeStore, MemoryNoticeStore, MemoryWorkQueue } from '../src/memory.ts';
import { FakeClock, USER_A, USER_B } from './helpers.ts';

describe('memory adapters', () => {
  it('dedupe claims a key once until it expires', async () => {
    const clock = new FakeClock();
    const store = new MemoryDedupeStore(clock);
    expect(await store.claim('evt_1', 60)).toBe(true);
    expect(await store.claim('evt_1', 60)).toBe(false);
    clock.t += 61_000;
    expect(await store.claim('evt_1', 60)).toBe(true);
  });

  it('notices are isolated per Discord user and per backend, and idempotent by id', async () => {
    const clock = new FakeClock();
    const store = new MemoryNoticeStore(clock);
    const n = { id: 'n1', backend: 'production', kind: 'speed_penalty' as const, text: 't', createdAt: clock.t, expiresAt: clock.t + 1000 };
    await store.add(USER_A, n);
    await store.add(USER_A, n);
    await store.add(USER_A, { ...n, id: 'n2', backend: 'test' });
    expect(await store.countUnread(USER_A, 'production')).toBe(1);
    expect(await store.countUnread(USER_A, 'test')).toBe(1);
    expect(await store.countUnread(USER_B, 'production')).toBe(0);
    await store.markRead(USER_B, ['n1']);
    expect(await store.countUnread(USER_A, 'production')).toBe(1);
  });

  it('the work queue only accepts JSON-serializable items', async () => {
    const q = new MemoryWorkQueue<{ a: unknown }>();
    await q.send({ a: 1n }).catch(() => {});
    expect(q.items).toHaveLength(0);
    await q.send({ a: { b: [1, 'x'] } }, { delaySeconds: 5 });
    expect(q.items).toEqual([{ item: { a: { b: [1, 'x'] } }, delaySeconds: 5 }]);
  });
});
