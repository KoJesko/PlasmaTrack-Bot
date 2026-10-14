import type {
  BlobCache,
  CachedBlob,
  Clock,
  DedupeStore,
  JobVersionStore,
  Notice,
  NoticeStore,
  ReviewPost,
  ReviewPostStore,
  TokenGrant,
  TokenGrantStore,
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

  async sendBatch(items: T[]): Promise<void> {
    for (const item of items) await this.send(item);
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

  async release(key: string): Promise<void> {
    this.seen.delete(key);
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

export class MemoryJobVersionStore implements JobVersionStore {
  private readonly versions = new Map<string, { version: number; at: number }>();
  private readonly clock: Clock;

  constructor(clock: Clock = systemClock) {
    this.clock = clock;
  }

  async advance(jobId: string, version: number): Promise<boolean> {
    const current = this.versions.get(jobId);
    if (current && current.version >= version) return false;
    this.versions.set(jobId, { version, at: this.clock.now() });
    return true;
  }

  async current(jobId: string): Promise<number | null> {
    return this.versions.get(jobId)?.version ?? null;
  }

  async purgeOlderThan(before: number): Promise<number> {
    let n = 0;
    for (const [id, v] of this.versions) {
      if (v.at < before) {
        this.versions.delete(id);
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

  async countUnread(discordUserId: string, backend: string): Promise<number> {
    return this.unread(discordUserId, backend).length;
  }

  async listUnread(discordUserId: string, backend: string, limit: number): Promise<Notice[]> {
    return this.unread(discordUserId, backend)
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

  private unread(discordUserId: string, backend: string): Notice[] {
    const now = this.clock.now();
    return (this.byUser.get(discordUserId) ?? [])
      .filter((e) => !e.read && e.notice.expiresAt > now && e.notice.backend === backend)
      .map((e) => e.notice);
  }
}

export class MemoryTokenGrantStore implements TokenGrantStore {
  readonly grants = new Map<string, TokenGrant>();
  private readonly clock: Clock;

  constructor(clock: Clock = systemClock) {
    this.clock = clock;
  }

  async create(grant: TokenGrant): Promise<void> {
    this.grants.set(grant.id, { ...grant });
  }

  async get(id: string): Promise<TokenGrant | null> {
    const g = this.grants.get(id);
    return g ? { ...g } : null;
  }

  async pendingFor(discordUserId: string, backend: string): Promise<TokenGrant[]> {
    const now = this.clock.now();
    return [...this.grants.values()]
      .filter((g) => g.discordUserId === discordUserId && g.backend === backend && g.usedAt === null && g.expiresAt > now)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((g) => ({ ...g }));
  }

  async markUsed(id: string, at: number): Promise<void> {
    const g = this.grants.get(id);
    if (g) g.usedAt = at;
  }

  async purgeExpired(): Promise<number> {
    const now = this.clock.now();
    let n = 0;
    for (const [id, g] of this.grants) {
      if (g.expiresAt <= now) {
        this.grants.delete(id);
        n++;
      }
    }
    return n;
  }
}

export class MemoryReviewPostStore implements ReviewPostStore {
  readonly posts: ReviewPost[] = [];

  async put(post: ReviewPost): Promise<void> {
    const i = this.posts.findIndex((p) => p.backend === post.backend && p.jobId === post.jobId && p.channelId === post.channelId);
    if (i === -1) this.posts.push({ ...post });
    else this.posts[i] = { ...post };
  }

  async find(backend: string, jobId: string): Promise<ReviewPost[]> {
    return this.posts.filter((p) => p.backend === backend && p.jobId === jobId).map((p) => ({ ...p }));
  }
}
