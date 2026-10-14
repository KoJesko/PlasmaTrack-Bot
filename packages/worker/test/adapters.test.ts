import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { CloudflareWorkQueue, D1DedupeStore, D1NoticeStore, R2BlobCache } from '../src/adapters.ts';
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
});

describe('D1NoticeStore', () => {
  const notice = (id: string, createdAt: number, text = id) => ({
    id,
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

    expect(await store.countUnread(USER_A)).toBe(2);
    expect((await store.listUnread(USER_A, 10)).map((n) => n.id)).toEqual(['n2', 'n1']);
    expect((await store.listUnread(USER_B, 10)).map((n) => n.text)).toEqual(['belongs to B']);

    // Marking read is scoped to the user: B's "n1" is untouched.
    await store.markRead(USER_A, ['n1', 'n2']);
    expect(await store.countUnread(USER_A)).toBe(0);
    expect(await store.countUnread(USER_B)).toBe(1);
  });

  it('hides and purges expired notices', async () => {
    const clock = new Clock();
    const store = new D1NoticeStore(env.DB, clock);
    await store.add(USER_A, notice('old', clock.t));
    clock.t += 3_600_001;
    expect(await store.countUnread(USER_A)).toBe(0);
    expect(await store.purgeExpired()).toBe(1);
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
});
