// Cloudflare implementations of the core storage ports. This is the only
// place that knows about D1, Queues and R2; moving hosts means replacing this file.

import type {
  BlobCache,
  CachedBlob,
  Clock,
  DedupeStore,
  JobVersionStore,
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

  async sendBatch(items: T[]): Promise<void> {
    // Queues accept at most 100 messages per sendBatch call.
    for (let i = 0; i < items.length; i += 100) {
      await this.queue.sendBatch(items.slice(i, i + 100).map((body) => ({ body })));
    }
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

  async release(key: string): Promise<void> {
    await this.db.prepare('DELETE FROM dedupe WHERE key = ?1').bind(key).run();
  }

  async purgeExpired(): Promise<number> {
    const result = await this.db.prepare('DELETE FROM dedupe WHERE expires_at <= ?1').bind(this.clock.now()).run();
    return result.meta.changes;
  }
}

export class D1JobVersionStore implements JobVersionStore {
  private readonly db: D1Database;
  private readonly clock: Clock;

  constructor(db: D1Database, clock: Clock = systemClock) {
    this.db = db;
    this.clock = clock;
  }

  async advance(jobId: string, version: number): Promise<boolean> {
    // Insert, or raise the stored version; an equal or older one changes nothing.
    const result = await this.db
      .prepare(
        `INSERT INTO job_versions (job_id, version, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (job_id) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at
         WHERE job_versions.version < excluded.version`,
      )
      .bind(jobId, version, this.clock.now())
      .run();
    return result.meta.changes === 1;
  }

  async purgeOlderThan(before: number): Promise<number> {
    const result = await this.db.prepare('DELETE FROM job_versions WHERE updated_at < ?1').bind(before).run();
    return result.meta.changes;
  }
}

interface NoticeRow {
  id: string;
  backend: string;
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
        `INSERT OR IGNORE INTO notices (discord_user_id, id, backend, kind, text, created_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      )
      .bind(discordUserId, notice.id, notice.backend, notice.kind, notice.text, notice.createdAt, notice.expiresAt)
      .run();
  }

  async countUnread(discordUserId: string, backend: string): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM notices
         WHERE discord_user_id = ?1 AND backend = ?3 AND read_at IS NULL AND expires_at > ?2`,
      )
      .bind(discordUserId, this.clock.now(), backend)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  async listUnread(discordUserId: string, backend: string, limit: number): Promise<Notice[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id, backend, kind, text, created_at, expires_at FROM notices
         WHERE discord_user_id = ?1 AND backend = ?4 AND read_at IS NULL AND expires_at > ?2
         ORDER BY created_at DESC LIMIT ?3`,
      )
      .bind(discordUserId, this.clock.now(), limit, backend)
      .all<NoticeRow>();
    return results.map((r) => ({
      id: r.id,
      backend: r.backend,
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
