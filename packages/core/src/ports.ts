// Storage and scheduling interfaces. The core only talks to these; each host
// provides adapters (Cloudflare: Queues, D1, R2 in packages/worker; memory
// adapters in ./memory.ts for tests and single-process hosts).

export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** At-least-once background work. Handlers must tolerate redelivery. */
export interface WorkQueue<T> {
  send(item: T, options?: { delaySeconds?: number }): Promise<void>;
}

/** Remembers keys for a while; used to drop duplicate webhook deliveries. */
export interface DedupeStore {
  /** Returns true if the key was not seen before (and records it), false if it was. */
  claim(key: string, ttlSeconds: number): Promise<boolean>;
  purgeExpired(): Promise<number>;
}

export interface CachedBlob {
  bytes: Uint8Array<ArrayBuffer>;
  contentType: string;
}

/** Content-addressed cache for rendered images. */
export interface BlobCache {
  get(key: string): Promise<CachedBlob | null>;
  put(key: string, blob: CachedBlob): Promise<void>;
}

export type NoticeKind = 'invalid_delivery' | 'speed_penalty' | 'revocation_scheduled' | 'other';

export interface Notice {
  id: string;
  kind: NoticeKind;
  text: string;
  createdAt: number;
  expiresAt: number;
}

/**
 * Notices that could not be sent as DMs. They reveal a player's Invalid or
 * penalty status, so every method is scoped to one Discord user: there is no
 * way to list or read another user's notices.
 */
export interface NoticeStore {
  add(discordUserId: string, notice: Notice): Promise<void>;
  countUnread(discordUserId: string): Promise<number>;
  /** Newest first, unread and unexpired only. */
  listUnread(discordUserId: string, limit: number): Promise<Notice[]>;
  markRead(discordUserId: string, ids: string[]): Promise<void>;
  purgeExpired(): Promise<number>;
}
