import type { QueueMessage } from '@plasmatrack/core';

/**
 * Worker bindings. Plain strings come from `[vars]` in wrangler.toml; secrets
 * (DISCORD_BOT_TOKEN, RENDERER_KEY, and per backend PLASMATRACK_BOT_TOKEN_<NAME>
 * and PLASMATRACK_WEBHOOK_SECRET_<NAME>) from `wrangler secret put` or
 * `.dev.vars`. GUILDS and BACKENDS are TOML tables in [vars].
 * They are validated by `parseBotConfig` before use.
 */
export interface Env {
  DB: D1Database;
  WORK_QUEUE: Queue<QueueMessage>;
  RENDER_CACHE: R2Bucket;

  DISCORD_APPLICATION_ID: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_BOT_TOKEN: string;
  GUILDS: Record<string, unknown> | string;
  BACKENDS: Record<string, unknown> | string;
  NOTICE_TTL_DAYS?: string;
  RENDERER_URL: string;
  RENDERER_KEY: string;
  /** Per-backend secrets, e.g. PLASMATRACK_BOT_TOKEN_PRODUCTION. */
  [secret: `PLASMATRACK_${string}`]: string | undefined;
}
