import type {
  BlobCache,
  CachedBlob,
  Clock,
  DedupeStore,
  Notice,
  NoticeStore,
  WorkQueue,
} from './ports.ts';
import { systemClock } from './ports.ts';

export class MemoryWorkQueue<T> implements WorkQueue<T> {
  readonly items: { item: T; delaySeconds?: number }[] = [];

  async send(item: T, options?: { delaySeconds?: number }): Promise<void> {
    // Round-trip through JSON, like a real queue, so non-serializable data fails in tests.
    const copy = JSON.parse(JSON.stringify(item)) as T;
    this.items.push(
      options?.delaySeconds === undefined ? { item: copy } : { item: copy, delaySeconds: options.delaySeconds },
    );
  }

  take(): T[] {
    return this.items.splice(0).map((e) => e.item);
  }
}

export class MemoryDedupeStore implements DedupeStore {
  private readonly seen = new Map<string, number>();
  private readonly clock: Clock;

  constructor(clock: Clock = systemClock) {
    this.clock = clock;
  }

  async claim(key: string, ttlSeconds: number): Promise<boolean> {
    const now = this.clock.now();
    const expires = this.seen.get(key);
    if (expires !== undefined && expires > now) return false;
    this.seen.set(key, now + ttlSeconds * 1000);
    return true;
  }

  async purgeExpired(): Promise<number> {
    const now = this.clock.now();
    let n = 0;
    for (const [k, exp] of this.seen) {
      if (exp <= now) {
        this.seen.delete(k);
        n++;
      }
    }
    return n;
  }
}

export class MemoryBlobCache implements BlobCache {
  readonly blobs = new Map<string, CachedBlob>();

  async get(key: string): Promise<CachedBlob | null> {
    return this.blobs.get(key) ?? null;
  }

  async put(key: string, blob: CachedBlob): Promise<void> {
    this.blobs.set(key, blob);
  }
}

export class MemoryNoticeStore implements NoticeStore {
  private readonly byUser = new Map<string, { notice: Notice; read: boolean }[]>();
  private readonly clock: Clock;

  constructor(clock: Clock = systemClock) {
    this.clock = clock;
  }

  async add(discordUserId: string, notice: Notice): Promise<void> {
    const list = this.byUser.get(discordUserId) ?? [];
    if (!list.some((e) => e.notice.id === notice.id)) list.push({ notice, read: false });
    this.byUser.set(discordUserId, list);
  }

  async countUnread(discordUserId: string): Promise<number> {
    return this.unread(discordUserId).length;
  }

  async listUnread(discordUserId: string, limit: number): Promise<Notice[]> {
    return this.unread(discordUserId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  async markRead(discordUserId: string, ids: string[]): Promise<void> {
    for (const e of this.byUser.get(discordUserId) ?? []) {
      if (ids.includes(e.notice.id)) e.read = true;
    }
  }

  async purgeExpired(): Promise<number> {
    const now = this.clock.now();
    let n = 0;
    for (const [user, list] of this.byUser) {
      const kept = list.filter((e) => e.notice.expiresAt > now);
      n += list.length - kept.length;
      this.byUser.set(user, kept);
    }
    return n;
  }

  private unread(discordUserId: string): Notice[] {
    const now = this.clock.now();
    return (this.byUser.get(discordUserId) ?? [])
      .filter((e) => !e.read && e.notice.expiresAt > now)
      .map((e) => e.notice);
  }
}
