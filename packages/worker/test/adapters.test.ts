import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  CloudflareWorkQueue,
  D1DedupeStore,
  D1JobVersionStore,
  D1NoticeStore,
  D1ReviewPostStore,
  D1TokenGrantStore,
  R2BlobCache,
} from '../src/adapters.ts';
import { USER_A, USER_B } from './helpers.ts';

class Clock {
  t = Date.UTC(2026, 8, 28, 12);
  now() {
    return this.t;
  }
}

describe('D1DedupeStore', () => {
  it('claims a key once, then again only after it expires', async () => {
    const clock = new Clock();
    const store = new D1DedupeStore(env.DB, clock);
    expect(await store.claim('evt_1', 60)).toBe(true);
    expect(await store.claim('evt_1', 60)).toBe(false);
    expect(await store.claim('evt_2', 60)).toBe(true);
    clock.t += 60_000;
    expect(await store.claim('evt_1', 60)).toBe(true);
    clock.t += 120_000;
    expect(await store.purgeExpired()).toBe(2);
  });

  it('releases a claim so a failed attempt can run again', async () => {
    const store = new D1DedupeStore(env.DB, new Clock());
    expect(await store.claim('evt_r', 60)).toBe(true);
    await store.release('evt_r');
    expect(await store.claim('evt_r', 60)).toBe(true);
  });
});

describe('D1JobVersionStore', () => {
  it('only moves forward, then forgets old jobs', async () => {
    const clock = new Clock();
    const store = new D1JobVersionStore(env.DB, clock);
    expect(await store.advance('7K2M9QXA', 3)).toBe(true);
    expect(await store.advance('7K2M9QXA', 3)).toBe(false);
    expect(await store.advance('7K2M9QXA', 2)).toBe(false);
    expect(await store.advance('7K2M9QXA', 4)).toBe(true);
    clock.t += 1000;
    expect(await store.purgeOlderThan(clock.t)).toBe(1);
    expect(await store.advance('7K2M9QXA', 1)).toBe(true);
  });
});

describe('D1NoticeStore', () => {
  const notice = (id: string, createdAt: number, text = id, backend = 'production') => ({
    id,
    backend,
    kind: 'invalid_delivery' as const,
    text,
    createdAt,
    expiresAt: createdAt + 3_600_000,
  });

  it('keeps each user’s notices separate, newest first, idempotent by id', async () => {
    const clock = new Clock();
    const store = new D1NoticeStore(env.DB, clock);
    await store.add(USER_A, notice('n1', clock.t - 3000));
    await store.add(USER_A, notice('n2', clock.t - 1000));
    await store.add(USER_A, notice('n2', clock.t - 1000));
    await store.add(USER_B, notice('n1', clock.t - 2000, 'belongs to B'));

    expect(await store.countUnread(USER_A, 'production')).toBe(2);
    expect((await store.listUnread(USER_A, 'production', 10)).map((n) => n.id)).toEqual(['n2', 'n1']);
    expect((await store.listUnread(USER_B, 'production', 10)).map((n) => n.text)).toEqual(['belongs to B']);

    // Another backend's notices are not listed here.
    await store.add(USER_A, notice('t1', clock.t, 'from the test backend', 'test'));
    expect((await store.listUnread(USER_A, 'production', 10)).map((n) => n.id)).toEqual(['n2', 'n1']);
    expect((await store.listUnread(USER_A, 'test', 10)).map((n) => n.id)).toEqual(['t1']);

    // Marking read is scoped to the user: B's "n1" is untouched.
    await store.markRead(USER_A, ['n1', 'n2']);
    expect(await store.countUnread(USER_A, 'production')).toBe(0);
    expect(await store.countUnread(USER_B, 'production')).toBe(1);
  });

  it('hides and purges expired notices', async () => {
    const clock = new Clock();
    const store = new D1NoticeStore(env.DB, clock);
    await store.add(USER_A, notice('old', clock.t));
    clock.t += 3_600_001;
    expect(await store.countUnread(USER_A, 'production')).toBe(0);
    // Storage is shared across this file's tests, so other expired rows may go too.
    expect(await store.purgeExpired()).toBeGreaterThanOrEqual(1);
    clock.t -= 3_600_001;
    expect(await store.countUnread(USER_A, 'production')).toBe(0);
  });
});

describe('R2BlobCache', () => {
  it('round-trips bytes and content type', async () => {
    const cache = new R2BlobCache(env.RENDER_CACHE);
    expect(await cache.get('route/abc.png')).toBeNull();
    await cache.put('route/abc.png', { bytes: new Uint8Array([1, 2, 3]), contentType: 'image/png' });
    const got = await cache.get('route/abc.png');
    expect(got?.contentType).toBe('image/png');
    expect([...got!.bytes]).toEqual([1, 2, 3]);
  });
});

describe('CloudflareWorkQueue', () => {
  it('passes the delay through to Queues', async () => {
    const calls: unknown[][] = [];
    const q = new CloudflareWorkQueue({ send: async (...args: unknown[]) => void calls.push(args) } as unknown as Queue<string>);
    await q.send('a');
    await q.send('b', { delaySeconds: 30 });
    expect(calls).toEqual([['a', undefined], ['b', { delaySeconds: 30 }]]);
  });

  it('sends batches in chunks of 100, the Queues limit', async () => {
    const sizes: number[] = [];
    const q = new CloudflareWorkQueue({
      sendBatch: async (msgs: unknown[]) => void sizes.push(msgs.length),
    } as unknown as Queue<number>);
    await q.sendBatch(Array.from({ length: 250 }, (_, i) => i));
    expect(sizes).toEqual([100, 100, 50]);
  });
});

describe('D1TokenGrantStore', () => {
  it('lists a player’s pending grants per backend, until used or expired', async () => {
    const clock = new Clock();
    const store = new D1TokenGrantStore(env.DB, clock);
    const grant = (id: string, backend = 'production') => ({
      id,
      backend,
      discordUserId: USER_A,
      moderatorId: USER_B,
      reason: 'Asked in #support',
      createdAt: clock.t,
      expiresAt: clock.t + 60_000,
      usedAt: null,
    });
    await store.create(grant('g1'));
    await store.create(grant('g2', 'test'));
    expect((await store.pendingFor(USER_A, 'production')).map((g) => g.id)).toEqual(['g1']);
    expect(await store.get('g1')).toMatchObject({ moderatorId: USER_B, reason: 'Asked in #support', usedAt: null });
    await store.markUsed('g1', clock.t);
    expect(await store.pendingFor(USER_A, 'production')).toEqual([]);
    clock.t += 60_001;
    expect(await store.pendingFor(USER_A, 'test')).toEqual([]);
    expect(await store.purgeExpired()).toBe(2);
  });
});

describe('D1ReviewPostStore', () => {
  it('keeps one post per job and channel, per backend', async () => {
    const store = new D1ReviewPostStore(env.DB);
    await store.put({ backend: 'production', jobId: '7K2M9QXA', channelId: '1', messageId: 'm1' });
    await store.put({ backend: 'production', jobId: '7K2M9QXA', channelId: '1', messageId: 'm2' });
    await store.put({ backend: 'test', jobId: '7K2M9QXA', channelId: '2', messageId: 'm3' });
    expect(await store.find('production', '7K2M9QXA')).toEqual([{ backend: 'production', jobId: '7K2M9QXA', channelId: '1', messageId: 'm2' }]);
  });
});
