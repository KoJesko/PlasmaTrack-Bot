import type { QueueMessage } from '@plasmatrack/core';

/**
 * Worker bindings. Plain strings come from `[vars]` in wrangler.toml; secrets
 * (DISCORD_BOT_TOKEN, RENDERER_KEY, PLASMATRACK_BOT_TOKEN,
 * PLASMATRACK_WEBHOOK_SECRET) from `wrangler secret put` or `.dev.vars`.
 * They are validated by `parseBotConfig` before use.
 */
export interface Env {
  DB: D1Database;
  WORK_QUEUE: Queue<QueueMessage>;
  RENDER_CACHE: R2Bucket;

  DISCORD_APPLICATION_ID: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_BOT_TOKEN: string;
  DISCORD_GUILD_ID: string;
  MODERATOR_ROLE_IDS: string;
  NOTICE_TTL_DAYS?: string;
  RENDERER_URL: string;
  RENDERER_KEY: string;
  PLASMATRACK_API_URL?: string;
  PLASMATRACK_BOT_TOKEN?: string;
  PLASMATRACK_WEBHOOK_SECRET?: string;
}
