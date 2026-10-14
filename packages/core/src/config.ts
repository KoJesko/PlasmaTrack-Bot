import { z } from 'zod';

// Bot configuration. Non-secret values come from the host's plain config
// (wrangler `[vars]`); secrets come from the host's secret store
// (`wrangler secret put`, or `.dev.vars` locally). Nothing here has a default
// that could leak into the repo.

const snowflake = z.string().regex(/^\d{17,20}$/, 'must be a Discord ID (17-20 digits)');

const snowflakeList = z
  .string()
  .transform((s) => s.split(',').map((p) => p.trim()).filter(Boolean))
  .pipe(z.array(snowflake).min(1, 'at least one ID is required'));

export const SECRET_KEYS = ['DISCORD_BOT_TOKEN', 'RENDERER_KEY'] as const;

export const botConfigSchema = z.object({
  DISCORD_APPLICATION_ID: snowflake,
  DISCORD_PUBLIC_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex characters'),
  DISCORD_BOT_TOKEN: z.string().min(20),
  /** The one guild where moderator commands are registered and allowed. */
  DISCORD_GUILD_ID: snowflake,
  /** Comma-separated role IDs whose members may use moderator commands. */
  MODERATOR_ROLE_IDS: snowflakeList,
  /** How long an undelivered notice is kept for `/notices`. */
  NOTICE_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  RENDERER_URL: z.url(),
  /** Shared HMAC key between this bot and the renderer service. */
  RENDERER_KEY: z.string().min(32, 'use at least 32 random characters'),
});

export type BotConfig = z.infer<typeof botConfigSchema>;

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/**
 * Parses the host environment. Error messages name the offending keys and the
 * rule they broke, never the values.
 */
export function parseBotConfig(env: Record<string, unknown>): BotConfig {
  const result = botConfigSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map(
      (i) => `${i.path.join('.') || '(root)'}: ${i.code === 'invalid_type' ? 'missing or wrong type' : i.message}`,
    );
    throw new ConfigError(`Invalid bot configuration:\n  ${problems.join('\n  ')}`);
  }
  return result.data;
}

export function secretValues(config: BotConfig): string[] {
  return SECRET_KEYS.map((k) => config[k]);
}
