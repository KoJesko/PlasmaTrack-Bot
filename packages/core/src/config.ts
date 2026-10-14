import { z } from 'zod';

// Bot configuration. Non-secret values come from the host's plain config
// (wrangler `[vars]`); secrets come from the host's secret store
// (`wrangler secret put`, or `.dev.vars` locally). Nothing here has a default
// that could leak into the repo.
//
// Each Discord server (guild) has its own settings and its own PlasmaTrack
// backend, so a test server never sees production data (owner's decision,
// 2026-10-14).

const snowflake = z.string().regex(/^\d{17,20}$/, 'must be a Discord ID (17-20 digits)');
const backendName = z.string().regex(/^[a-z][a-z0-9]{0,31}$/, 'backend names are lowercase letters and digits');

const secretList = z
  .string()
  .transform((s) => s.split(',').map((p) => p.trim()).filter(Boolean))
  .pipe(z.array(z.string().min(32, 'each secret needs at least 32 random characters')).min(1).max(2));

/** wrangler passes TOML tables in [vars] as objects; a JSON string is accepted too (e.g. from .dev.vars). */
const objectOrJson = z.preprocess((v) => {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}, z.unknown());

const guildSchema = z.object({
  /** Which PlasmaTrack backend this server's commands and review posts use. */
  backend: backendName,
  /** Roles allowed to use player commands. Empty: only moderators can use PlasmaTrack here. */
  member_roles: z.array(snowflake).default([]),
  /** Roles allowed to use moderator commands (the server also checks its own admin list). */
  moderator_roles: z.array(snowflake).default([]),
  /** Channel for review-queue posts; unset or "" means no posts. */
  review_channel: z
    .union([snowflake, z.literal('')])
    .optional()
    .transform((v) => v || undefined),
});

export type GuildSettings = z.infer<typeof guildSchema>;

const backendSchema = z.object({
  /** The PlasmaTrack server's origin (the client adds /api/v1). Unset: commands say it isn't connected. */
  api_url: z.url().optional(),
  /** Built-in demo data instead of a server (for test servers). Resets now and then; never real data. */
  demo: z.boolean().default(false),
});

const baseSchema = z.object({
  DISCORD_APPLICATION_ID: snowflake,
  DISCORD_PUBLIC_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex characters'),
  DISCORD_BOT_TOKEN: z.string().min(20),
  /** Per Discord server: `[vars.GUILDS.<guild id>]` tables. */
  GUILDS: objectOrJson.pipe(
    z.record(snowflake, guildSchema).refine((g) => Object.keys(g).length > 0, 'configure at least one guild'),
  ),
  /** PlasmaTrack backends by name: `[vars.BACKENDS.<name>]` tables. */
  BACKENDS: objectOrJson.pipe(z.record(backendName, backendSchema)),
  /** How long an undelivered notice is kept for `/notices`. */
  NOTICE_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  RENDERER_URL: z.url(),
  /** Shared HMAC key between this bot and the renderer service. */
  RENDERER_KEY: z.string().min(32, 'use at least 32 random characters'),
});

export interface BackendSettings {
  name: string;
  apiUrl: string | undefined;
  demo: boolean;
  /** PLASMATRACK_BOT_TOKEN_<NAME>: the server's bot token (server API_CONVENTIONS §2). */
  botToken: string | undefined;
  /** PLASMATRACK_WEBHOOK_SECRET_<NAME>: one, or two during a rotation (server WEBHOOKS §2). */
  webhookSecrets: string[];
}

export type BotConfig = Omit<z.infer<typeof baseSchema>, 'BACKENDS'> & {
  BACKENDS: Record<string, BackendSettings>;
};

/** Per-backend secret names, e.g. PLASMATRACK_BOT_TOKEN_PRODUCTION. */
export function backendSecretKeys(name: string) {
  const suffix = name.toUpperCase();
  return { botToken: `PLASMATRACK_BOT_TOKEN_${suffix}`, webhookSecret: `PLASMATRACK_WEBHOOK_SECRET_${suffix}` };
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/**
 * Parses the host environment. Error messages name the offending keys and the
 * rule they broke, never the values.
 */
export function parseBotConfig(env: Record<string, unknown>): BotConfig {
  const problems: string[] = [];
  const result = baseSchema.safeParse(env);
  if (!result.success) {
    for (const i of result.error.issues) {
      problems.push(`${i.path.join('.') || '(root)'}: ${i.code === 'invalid_type' ? 'missing or wrong type' : i.message}`);
    }
    throw new ConfigError(`Invalid bot configuration:\n  ${problems.join('\n  ')}`);
  }
  const base = result.data;

  const backends: Record<string, BackendSettings> = {};
  for (const [name, b] of Object.entries(base.BACKENDS)) {
    const keys = backendSecretKeys(name);
    const token = env[keys.botToken];
    const secrets = env[keys.webhookSecret] === undefined ? undefined : secretList.safeParse(env[keys.webhookSecret]);
    if (b.demo && b.api_url) problems.push(`BACKENDS.${name}: use either api_url or demo, not both`);
    if (b.api_url && (typeof token !== 'string' || token.length < 20)) problems.push(`${keys.botToken}: required with BACKENDS.${name}.api_url`);
    if (token !== undefined && !b.api_url) problems.push(`${keys.botToken}: set BACKENDS.${name}.api_url too`);
    if (secrets && !secrets.success) problems.push(`${keys.webhookSecret}: ${secrets.error.issues[0]?.message ?? 'invalid'}`);
    backends[name] = {
      name,
      apiUrl: b.api_url,
      demo: b.demo,
      botToken: typeof token === 'string' ? token : undefined,
      webhookSecrets: secrets?.success ? secrets.data : [],
    };
  }
  for (const [id, g] of Object.entries(base.GUILDS)) {
    if (!backends[g.backend]) problems.push(`GUILDS.${id}.backend: no backend named "${g.backend}" in BACKENDS`);
  }
  // A webhook secret identifies its backend, so two backends may never share one.
  const seen = new Set<string>();
  for (const b of Object.values(backends)) {
    for (const s of b.webhookSecrets) {
      if (seen.has(s)) problems.push(`${backendSecretKeys(b.name).webhookSecret}: shared with another backend; each needs its own`);
      seen.add(s);
    }
  }
  if (problems.length > 0) throw new ConfigError(`Invalid bot configuration:\n  ${problems.join('\n  ')}`);
  return { ...base, BACKENDS: backends };
}

export function secretValues(config: BotConfig): string[] {
  return [
    config.DISCORD_BOT_TOKEN,
    config.RENDERER_KEY,
    ...Object.values(config.BACKENDS).flatMap((b) => [...(b.botToken ? [b.botToken] : []), ...b.webhookSecrets]),
  ];
}
