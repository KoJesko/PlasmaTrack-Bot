import { z } from 'zod';
import { utf8 } from '../bytes.ts';
import type { BlobCache, Clock } from '../ports.ts';
import { systemClock } from '../ports.ts';

// Confirms TruckersMP accounts against TruckersMP's public API (owner's
// decision, 2026-10-14). The tracker only *reports* the account IDs it saw
// (server PUBLIC_API §2); an account counts as confirmed when its public
// TruckersMP profile shows the same Discord account.
//
// TruckersMP has no lookup from Discord ID to account, so only reported IDs
// can be checked. Lookups are cached for a day and only made on demand.

export const TRUCKERSMP_API = 'https://api.truckersmp.com/v2';
export const TRUCKERSMP_PROFILE = 'https://truckersmp.com/user/';
const CACHE_TTL_MS = 24 * 3600_000;
const USER_AGENT = 'PlasmaTrack-Bot/0.1 (Discord bot; non-commercial)';

export interface TruckersMpPlayer {
  accountId: number;
  name: string;
  /** The Discord account linked on TruckersMP, or null if none is linked or it is hidden. */
  discordId: string | null;
  banned: boolean;
}

export interface TruckersMpLookup {
  /** Null if the account doesn't exist or TruckersMP can't be reached right now. */
  player(accountId: number): Promise<TruckersMpPlayer | null>;
}

const playerResponse = z.looseObject({
  error: z.boolean(),
  response: z
    .looseObject({
      id: z.number().int(),
      name: z.string(),
      discordSnowflake: z.union([z.string(), z.number()]).nullable().optional(),
      banned: z.boolean().optional(),
    })
    .optional(),
});

interface CacheEntry {
  fetchedAt: number;
  player: TruckersMpPlayer | null;
}

export interface TruckersMpClientOptions {
  cache: BlobCache;
  fetch?: typeof fetch;
  clock?: Clock;
  timeoutMs?: number;
}

export class TruckersMpClient implements TruckersMpLookup {
  private readonly cache: BlobCache;
  private readonly fetchFn: typeof fetch;
  private readonly clock: Clock;
  private readonly timeoutMs: number;

  constructor(options: TruckersMpClientOptions) {
    this.cache = options.cache;
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
    this.clock = options.clock ?? systemClock;
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  async player(accountId: number): Promise<TruckersMpPlayer | null> {
    if (!Number.isInteger(accountId) || accountId <= 0) return null;
    const key = `truckersmp/player/${accountId}.json`;
    const cached = await this.cache.get(key);
    if (cached) {
      const entry = JSON.parse(new TextDecoder().decode(cached.bytes)) as CacheEntry;
      if (this.clock.now() - entry.fetchedAt < CACHE_TTL_MS) return entry.player;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchFn(`${TRUCKERSMP_API}/player/${accountId}`, {
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
        signal: controller.signal,
      });
    } catch {
      return null; // Unreachable: say "couldn't check", don't cache.
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 500 || res.status === 429) return null;

    let player: TruckersMpPlayer | null = null;
    const parsed = playerResponse.safeParse(await res.json().catch(() => null));
    if (res.ok && parsed.success && !parsed.data.error && parsed.data.response) {
      const p = parsed.data.response;
      const snowflake = p.discordSnowflake === null || p.discordSnowflake === undefined ? null : String(p.discordSnowflake);
      player = {
        accountId: p.id,
        name: p.name,
        discordId: snowflake && /^\d{17,20}$/.test(snowflake) ? snowflake : null,
        banned: p.banned ?? false,
      };
    }
    const entry: CacheEntry = { fetchedAt: this.clock.now(), player };
    await this.cache.put(key, { bytes: utf8(JSON.stringify(entry)), contentType: 'application/json' });
    return player;
  }
}

export type TruckersMpCheck =
  | { accountId: number; status: 'confirmed'; name: string }
  | { accountId: number; status: 'not-linked'; name: string }
  | { accountId: number; status: 'unknown' };

/** Checks each reported account against TruckersMP. At most `limit` lookups, in parallel. */
export async function checkTruckersMpAccounts(
  lookup: TruckersMpLookup,
  discordId: string,
  accountIds: readonly number[],
  limit = 5,
): Promise<TruckersMpCheck[]> {
  const ids = [...new Set(accountIds.filter((id) => id > 0))].slice(0, limit);
  return Promise.all(
    ids.map(async (accountId): Promise<TruckersMpCheck> => {
      const p = await lookup.player(accountId).catch(() => null);
      if (!p) return { accountId, status: 'unknown' };
      return { accountId, status: p.discordId === discordId ? 'confirmed' : 'not-linked', name: p.name };
    }),
  );
}
