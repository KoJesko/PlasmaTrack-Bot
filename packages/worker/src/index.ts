import {
  ConfigError,
  createLogger,
  demoApi,
  describeQueueMessage,
  RendererClient,
  DiscordRest,
  handleInteraction,
  handlers,
  HttpMediaFetcher,
  MessageFlags,
  parseBotConfig,
  PlasmaTrackApi,
  processQueueMessage,
  receiveWebhook,
  secretValues,
  START_FAILED,
  systemClock,
  tasks,
  TruckersMpClient,
  verifyDiscordSignature,
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_MAX_BYTES,
  WEBHOOK_SIGNATURE_HEADER,
  withReference,
  type BotConfig,
  type ConsumerDeps,
  type Logger,
  type QueueMessage,
} from '@plasmatrack/core';
import type { APIInteraction } from 'discord-api-types/v10';
import {
  CloudflareWorkQueue,
  D1DedupeStore,
  D1JobVersionStore,
  D1ManualDraftStore,
  D1NoticeStore,
  D1RateLimiter,
  D1ReviewPostStore,
  D1TokenGrantStore,
  R2BlobCache,
} from './adapters.ts';
import { backupDatabase } from './backup.ts';

export { RendererContainer } from './renderer-container.ts';

export const WEBHOOK_PATH = '/webhooks/plasmatrack';
/** Must match `max_retries` of the work queue's consumer in wrangler.toml. */
const MAX_RETRIES = 5;
/** Messages that used up their retries land in a queue with this suffix (`dead_letter_queue`). */
const DEAD_LETTER_SUFFIX = '-dlq';
/** Slash commands per user: at most this many per window (the owner's rule: 5 per 20 s). */
const COMMAND_LIMIT = 5;
const COMMAND_WINDOW_MS = 20_000;
/** The weekly D1 backup (Sundays 03:47 UTC). Must match a cron in wrangler.toml's [triggers]. */
export const BACKUP_CRON = '47 3 * * SUN';
/** Job versions are kept a week: longer than the server's 72 h retry window. */
const JOB_VERSION_RETENTION_MS = 7 * 24 * 3600_000;
import type { Env } from './env.ts';

interface Runtime {
  config: BotConfig;
  logger: Logger;
  apis: Map<string, PlasmaTrackApi | null>;
}

/** The API client for a backend: its server, the built-in demo, or null if not connected yet. */
function backendApi(rt: Runtime, name: string): PlasmaTrackApi | null {
  if (!rt.apis.has(name)) {
    const b = rt.config.BACKENDS[name];
    const api = !b
      ? null
      : b.demo
        ? demoApi()
        : b.apiUrl && b.botToken
          ? new PlasmaTrackApi({ baseUrl: b.apiUrl, token: b.botToken })
          : null;
    rt.apis.set(name, api);
  }
  return rt.apis.get(name) ?? null;
}

let cached: { env: Env; runtime: Runtime } | undefined;

/** Validates the environment once per isolate. */
function runtime(env: Env): Runtime {
  if (cached?.env === env) return cached.runtime;
  const config = parseBotConfig(env as unknown as Record<string, unknown>);
  const logger = createLogger(undefined, secretValues(config));
  cached = { env, runtime: { config, logger, apis: new Map() } };
  return cached.runtime;
}

/** One renderer container for the whole bot; it queues work itself. */
const RENDERER_INSTANCE = 'renderer';
/** A cold container start (boot + basemaps) comes before the first render. */
const CONTAINER_RENDER_TIMEOUT_MS = 60_000;

function consumerDeps(env: Env, rt: Runtime): ConsumerDeps {
  const container = env.RENDERER;
  const renderer = new RendererClient({
    key: rt.config.RENDERER_KEY,
    cache: new R2BlobCache(env.RENDER_CACHE),
    ...(container
      ? {
          // Reached through the binding only; the host name is never resolved.
          baseUrl: 'http://renderer.internal',
          fetch: (input, init) => container.get(container.idFromName(RENDERER_INSTANCE)).fetch(new Request(input, init)),
          timeoutMs: CONTAINER_RENDER_TIMEOUT_MS,
        }
      : { baseUrl: rt.config.RENDERER_URL }),
  });
  return {
    discord: new DiscordRest({ applicationId: rt.config.DISCORD_APPLICATION_ID, botToken: rt.config.DISCORD_BOT_TOKEN }),
    notices: new D1NoticeStore(env.DB),
    clock: systemClock,
    logger: rt.logger,
    renderer,
    images: renderer,
    // Evidence links point at the PlasmaTrack servers themselves.
    media: new HttpMediaFetcher({
      extraHosts: () => Object.values(rt.config.BACKENDS).flatMap((b) => (b.apiUrl ? [new URL(b.apiUrl).hostname] : [])),
    }),
    drafts: new D1ManualDraftStore(env.DB),
    backends: {
      forGuild: (guildId) => {
        const guild = guildId ? rt.config.GUILDS[guildId] : undefined;
        return guild ? { name: guild.backend, api: backendApi(rt, guild.backend) } : null;
      },
      byName: (name) => backendApi(rt, name),
    },
    grants: new D1TokenGrantStore(env.DB),
    reviewPosts: new D1ReviewPostStore(env.DB),
    reviewChannels: (backend) =>
      Object.values(rt.config.GUILDS)
        .filter((g) => g.backend === backend && g.review_channel)
        .map((g) => g.review_channel!),
    truckersmp: new TruckersMpClient({ cache: new R2BlobCache(env.RENDER_CACHE) }),
    dedupe: new D1DedupeStore(env.DB),
    jobVersions: new D1JobVersionStore(env.DB),
    queue: new CloudflareWorkQueue(env.WORK_QUEUE),
    noticeTtlDays: rt.config.NOTICE_TTL_DAYS,
  };
}

async function handleWebhookRequest(request: Request, env: Env, rt: Runtime) {
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > WEBHOOK_MAX_BYTES) return new Response('payload too large', { status: 413 });
  const body = new Uint8Array(await request.arrayBuffer());
  const res = await receiveWebhook(
    {
      body,
      signature: request.headers.get(WEBHOOK_SIGNATURE_HEADER),
      eventIdHeader: request.headers.get(WEBHOOK_EVENT_ID_HEADER),
    },
    {
      secrets: Object.fromEntries(Object.values(rt.config.BACKENDS).map((b) => [b.name, b.webhookSecrets])),
      queue: new CloudflareWorkQueue(env.WORK_QUEUE),
      logger: rt.logger,
      clock: systemClock,
    },
  );
  return new Response(res.body, { status: res.status });
}

async function handleInteractionRequest(request: Request, env: Env, ctx: ExecutionContext, rt: Runtime) {
  const body = await request.text();
  const valid = await verifyDiscordSignature(
    rt.config.DISCORD_PUBLIC_KEY,
    request.headers.get('X-Signature-Ed25519'),
    request.headers.get('X-Signature-Timestamp'),
    body,
  );
  if (!valid) return new Response('invalid request signature', { status: 401 });

  let interaction: APIInteraction;
  try {
    interaction = JSON.parse(body) as APIInteraction;
  } catch {
    return new Response('bad request', { status: 400 });
  }

  const queue = new CloudflareWorkQueue(env.WORK_QUEUE);
  const { response, background, after } = await handleInteraction(interaction, {
    handlers,
    applicationId: rt.config.DISCORD_APPLICATION_ID,
    guilds: rt.config.GUILDS,
    queue,
    logger: rt.logger,
    clock: systemClock,
    limiter: new D1RateLimiter(env.DB, COMMAND_LIMIT, COMMAND_WINDOW_MS),
    reportStartFailure: async (ref, kind) => {
      const discord = new DiscordRest({ applicationId: rt.config.DISCORD_APPLICATION_ID, botToken: rt.config.DISCORD_BOT_TOKEN });
      const message = { content: withReference(START_FAILED, ref.id), flags: MessageFlags.Ephemeral, allowed_mentions: { parse: [] } };
      // A command's "thinking…" reply becomes the error; a button's message stays as it was.
      await (kind === 'defer' ? discord.editOriginal(ref.token, message) : discord.followup(ref.token, message));
    },
  });
  if (after) ctx.waitUntil(after);
  if (background.length > 0) {
    ctx.waitUntil(
      Promise.all(background.map((m) => queue.send(m))).catch((err) =>
        rt.logger.warn('background enqueue failed', { err }),
      ),
    );
  }
  return Response.json(response);
}

export default {
  async fetch(request, env, ctx) {
    let rt: Runtime;
    try {
      rt = runtime(env);
    } catch (err) {
      // Key names only; parseBotConfig never includes values.
      console.error(err instanceof ConfigError ? err.message : 'configuration failed');
      return new Response('bot is misconfigured', { status: 500 });
    }

    const { pathname } = new URL(request.url);
    if (pathname === '/healthz' && request.method === 'GET') return new Response('ok');
    try {
      if (pathname === '/interactions' && request.method === 'POST') {
        return await handleInteractionRequest(request, env, ctx, rt);
      }
      if (pathname === WEBHOOK_PATH && request.method === 'POST') return await handleWebhookRequest(request, env, rt);
    } catch (err) {
      rt.logger.error('request failed', { path: pathname, err });
      return new Response('internal error', { status: 500 });
    }
    return new Response('not found', { status: 404 });
  },

  async queue(batch, env, _ctx) {
    const rt = runtime(env);
    if (batch.queue.endsWith(DEAD_LETTER_SUFFIX)) {
      // Out of retries. Record what was lost (no tokens or bodies) and let it go:
      // interaction tokens are long expired, and webhooks are the server's to resend.
      for (const message of batch.messages) {
        rt.logger.error('message dead-lettered', { ...describeQueueMessage(message.body), attempts: message.attempts });
        message.ack();
      }
      return;
    }
    const deps = consumerDeps(env, rt);
    // Messages are independent; run them side by side so one slow render
    // doesn't hold up the others in the batch.
    await Promise.all(
      batch.messages.map(async (message) => {
        try {
          const result = await processQueueMessage(message.body, tasks, deps, {
            attempt: message.attempts,
            maxAttempts: MAX_RETRIES + 1,
          });
          if (result.status === 'retry') message.retry({ delaySeconds: result.delaySeconds });
          else message.ack();
        } catch (err) {
          rt.logger.error('queue message crashed', { err });
          message.retry({ delaySeconds: 10 });
        }
      }),
    );
  },

  async scheduled(controller, env, ctx) {
    const rt = runtime(env);
    if (controller.cron === BACKUP_CRON) {
      if (!env.BACKUPS) {
        rt.logger.warn('backup skipped: no BACKUPS bucket bound');
        return;
      }
      ctx.waitUntil(
        backupDatabase(env.DB, env.BACKUPS, Date.now()).then(
          ({ key, bytes, rows, deleted }) => rt.logger.info('backup written', { key, bytes, rows, deleted }),
          (err: unknown) => rt.logger.error('backup failed', { err }),
        ),
      );
      return;
    }
    ctx.waitUntil(
      Promise.all([
        new D1DedupeStore(env.DB).purgeExpired(),
        new D1NoticeStore(env.DB).purgeExpired(),
        new D1JobVersionStore(env.DB).purgeOlderThan(Date.now() - JOB_VERSION_RETENTION_MS),
        new D1TokenGrantStore(env.DB).purgeExpired(),
        new D1RateLimiter(env.DB, COMMAND_LIMIT, COMMAND_WINDOW_MS).purgeOlderThan(Date.now()),
        new D1ManualDraftStore(env.DB).purgeExpired(),
      ]).then(([dedupe, notices, jobVersions, grants, rateLimits, drafts]) =>
        rt.logger.info('purged expired rows', { dedupe, notices, jobVersions, grants, rateLimits, drafts }),
      ),
    );
  },
} satisfies ExportedHandler<Env, QueueMessage>;
