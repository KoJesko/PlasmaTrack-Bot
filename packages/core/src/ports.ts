import type { ManualJobInput } from './api/client.ts';

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
  /** Many items at once (e.g. one DM per revocation recipient). */
  sendBatch(items: T[]): Promise<void>;
}

/**
 * A manual submission being prepared (/submit). One per player per backend:
 * starting again replaces it. Holds evidence IDs, never image bytes.
 */
export interface ManualDraft {
  id: string;
  backend: string;
  userId: string;
  /** Bumped on every change, so an older preview's Send button can't submit newer data. */
  rev: number;
  job: ManualJobInput;
  createdAt: number;
  expiresAt: number;
}

export interface ManualDraftStore {
  /** The player's draft, or null if none or expired. */
  get(backend: string, userId: string): Promise<ManualDraft | null>;
  /** Saves it, replacing any draft of the same player. */
  put(draft: ManualDraft): Promise<void>;
  /** Deletes the player's draft if it is still `id`; true if it was there. */
  delete(backend: string, userId: string, id: string): Promise<boolean>;
  purgeExpired(): Promise<number>;
}

/** A per-key budget, e.g. queued commands per user. Hosts may count approximately. */
export interface RateLimiter {
  /** True if the key may go ahead now (and counts this use). */
  allow(key: string): Promise<boolean>;
}

/** Remembers keys for a while; used to drop duplicate webhook deliveries. */
export interface DedupeStore {
  /** Returns true if the key was not seen before (and records it), false if it was. */
  claim(key: string, ttlSeconds: number): Promise<boolean>;
  /** Forgets a claim, so a failed attempt can be retried. */
  release(key: string): Promise<void>;
  purgeExpired(): Promise<number>;
}

/**
 * Highest `job_version` handled per job. Webhooks have no ordering guarantee
 * (server WEBHOOKS §3), so an event older than one already handled is ignored.
 */
export interface JobVersionStore {
  /** Records `version` and returns true if it is newer than any seen for the job; false otherwise. */
  advance(jobId: string, version: number): Promise<boolean>;
  /** The highest version handled so far, or null. */
  current(jobId: string): Promise<number | null>;
  /** Forgets jobs not updated since `before` (ms). Webhooks are retried for at most 72 h. */
  purgeOlderThan(before: number): Promise<number>;
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

export type NoticeKind = 'invalid_delivery' | 'speed_penalty' | 'revocation_scheduled' | 'revocation_cancelled' | 'other';

export interface Notice {
  id: string;
  /** The PlasmaTrack backend it came from; /notices in a server shows only that server's backend. */
  backend: string;
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
  countUnread(discordUserId: string, backend: string): Promise<number>;
  /** Newest first, unread and unexpired only. */
  listUnread(discordUserId: string, backend: string, limit: number): Promise<Notice[]>;
  markRead(discordUserId: string, ids: string[]): Promise<void>;
  purgeExpired(): Promise<number>;
}

/**
 * A moderator-issued token waiting for its player (ADMIN_API §10). Holds who
 * issued it and why, never a token: the token is created when the player
 * clicks, with the issuing moderator as the actor.
 */
export interface TokenGrant {
  id: string;
  backend: string;
  discordUserId: string;
  moderatorId: string;
  reason: string;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
}

export interface TokenGrantStore {
  create(grant: TokenGrant): Promise<void>;
  get(id: string): Promise<TokenGrant | null>;
  /** Unused, unexpired grants for a player in one backend, newest first. */
  pendingFor(discordUserId: string, backend: string): Promise<TokenGrant[]>;
  markUsed(id: string, at: number): Promise<void>;
  purgeExpired(): Promise<number>;
}

/** Which review-channel message shows which job, per backend and channel. */
export interface ReviewPost {
  backend: string;
  jobId: string;
  channelId: string;
  messageId: string;
}

export interface ReviewPostStore {
  put(post: ReviewPost): Promise<void>;
  /** Every post of that job in that backend (one per review channel). */
  find(backend: string, jobId: string): Promise<ReviewPost[]>;
}
