// Cloudflare implementations of the core storage ports. This is the only
// place that knows about D1, Queues and R2; moving hosts means replacing this file.

import type {
  BlobCache,
  CachedBlob,
  Clock,
  DedupeStore,
  Notice,
  NoticeKind,
  NoticeStore,
  WorkQueue,
} from '@plasmatrack/core';
import { systemClock } from '@plasmatrack/core';

export class CloudflareWorkQueue<T> implements WorkQueue<T> {
  private readonly queue: Queue<T>;

  constructor(queue: Queue<T>) {
    this.queue = queue;
  }

  async send(item: T, options?: { delaySeconds?: number }): Promise<void> {
    await this.queue.send(item, options?.delaySeconds ? { delaySeconds: options.delaySeconds } : undefined);
  }
}

export class D1DedupeStore implements DedupeStore {
  private readonly db: D1Database;
  private readonly clock: Clock;

  constructor(db: D1Database, clock: Clock = systemClock) {
    this.db = db;
    this.clock = clock;
  }

  async claim(key: string, ttlSeconds: number): Promise<boolean> {
    const now = this.clock.now();
    // Insert, or take over an expired row; a live row is left alone (0 changes).
    const result = await this.db
      .prepare(
        `INSERT INTO dedupe (key, expires_at) VALUES (?1, ?2)
         ON CONFLICT (key) DO UPDATE SET expires_at = excluded.expires_at
         WHERE dedupe.expires_at <= ?3`,
      )
      .bind(key, now + ttlSeconds * 1000, now)
      .run();
    return result.meta.changes === 1;
  }

  async purgeExpired(): Promise<number> {
    const result = await this.db.prepare('DELETE FROM dedupe WHERE expires_at <= ?1').bind(this.clock.now()).run();
    return result.meta.changes;
  }
}

interface NoticeRow {
  id: string;
  kind: string;
  text: string;
  created_at: number;
  expires_at: number;
}

export class D1NoticeStore implements NoticeStore {
  private readonly db: D1Database;
  private readonly clock: Clock;

  constructor(db: D1Database, clock: Clock = systemClock) {
    this.db = db;
    this.clock = clock;
  }

  async add(discordUserId: string, notice: Notice): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO notices (discord_user_id, id, kind, text, created_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      )
      .bind(discordUserId, notice.id, notice.kind, notice.text, notice.createdAt, notice.expiresAt)
      .run();
  }

  async countUnread(discordUserId: string): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM notices
         WHERE discord_user_id = ?1 AND read_at IS NULL AND expires_at > ?2`,
      )
      .bind(discordUserId, this.clock.now())
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  async listUnread(discordUserId: string, limit: number): Promise<Notice[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id, kind, text, created_at, expires_at FROM notices
         WHERE discord_user_id = ?1 AND read_at IS NULL AND expires_at > ?2
         ORDER BY created_at DESC LIMIT ?3`,
      )
      .bind(discordUserId, this.clock.now(), limit)
      .all<NoticeRow>();
    return results.map((r) => ({
      id: r.id,
      kind: r.kind as NoticeKind,
      text: r.text,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
    }));
  }

  async markRead(discordUserId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const now = this.clock.now();
    const stmt = this.db.prepare('UPDATE notices SET read_at = ?1 WHERE discord_user_id = ?2 AND id = ?3');
    await this.db.batch(ids.map((id) => stmt.bind(now, discordUserId, id)));
  }

  async purgeExpired(): Promise<number> {
    const result = await this.db.prepare('DELETE FROM notices WHERE expires_at <= ?1').bind(this.clock.now()).run();
    return result.meta.changes;
  }
}

/** Rendered images, keyed by a hash of their inputs. Expiry is an R2 lifecycle rule. */
export class R2BlobCache implements BlobCache {
  private readonly bucket: R2Bucket;

  constructor(bucket: R2Bucket) {
    this.bucket = bucket;
  }

  async get(key: string): Promise<CachedBlob | null> {
    const obj = await this.bucket.get(key);
    if (!obj) return null;
    return {
      bytes: new Uint8Array(await obj.arrayBuffer()),
      contentType: obj.httpMetadata?.contentType ?? 'application/octet-stream',
    };
  }

  async put(key: string, blob: CachedBlob): Promise<void> {
    await this.bucket.put(key, blob.bytes, { httpMetadata: { contentType: blob.contentType } });
  }
}
