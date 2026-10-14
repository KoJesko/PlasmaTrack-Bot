import {
  ConfigError,
  createLogger,
  RendererClient,
  DiscordRest,
  handleInteraction,
  handlers,
  parseBotConfig,
  PlasmaTrackApi,
  processQueueMessage,
  receiveWebhook,
  secretValues,
  systemClock,
  tasks,
  verifyDiscordSignature,
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_MAX_BYTES,
  WEBHOOK_SIGNATURE_HEADER,
  type BotConfig,
  type ConsumerDeps,
  type Logger,
  type QueueMessage,
} from '@plasmatrack/core';
import type { APIInteraction } from 'discord-api-types/v10';
import { CloudflareWorkQueue, D1DedupeStore, D1JobVersionStore, D1NoticeStore, R2BlobCache } from './adapters.ts';

export const WEBHOOK_PATH = '/webhooks/plasmatrack';
/** Job versions are kept a week: longer than the server's 72 h retry window. */
const JOB_VERSION_RETENTION_MS = 7 * 24 * 3600_000;
import type { Env } from './env.ts';

interface Runtime {
  config: BotConfig;
  logger: Logger;
}

let cached: { env: Env; runtime: Runtime } | undefined;

/** Validates the environment once per isolate. */
function runtime(env: Env): Runtime {
  if (cached?.env === env) return cached.runtime;
  const config = parseBotConfig(env as unknown as Record<string, unknown>);
  const logger = createLogger(undefined, secretValues(config));
  cached = { env, runtime: { config, logger } };
  return cached.runtime;
}

function consumerDeps(env: Env, rt: Runtime): ConsumerDeps {
  return {
    discord: new DiscordRest({ applicationId: rt.config.DISCORD_APPLICATION_ID, botToken: rt.config.DISCORD_BOT_TOKEN }),
    notices: new D1NoticeStore(env.DB),
    clock: systemClock,
    logger: rt.logger,
    renderer: new RendererClient({
      baseUrl: rt.config.RENDERER_URL,
      key: rt.config.RENDERER_KEY,
      cache: new R2BlobCache(env.RENDER_CACHE),
    }),
    api:
      rt.config.PLASMATRACK_API_URL && rt.config.PLASMATRACK_BOT_TOKEN
        ? new PlasmaTrackApi({ baseUrl: rt.config.PLASMATRACK_API_URL, token: rt.config.PLASMATRACK_BOT_TOKEN })
        : null,
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
      secrets: rt.config.PLASMATRACK_WEBHOOK_SECRET ?? [],
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
  const { response, background } = await handleInteraction(interaction, {
    handlers,
    applicationId: rt.config.DISCORD_APPLICATION_ID,
    guildIds: rt.config.DISCORD_GUILD_ID,
    moderatorRoleIds: rt.config.MODERATOR_ROLE_IDS,
    queue,
    logger: rt.logger,
    clock: systemClock,
  });
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
    if (pathname === '/interactions' && request.method === 'POST') {
      return handleInteractionRequest(request, env, ctx, rt);
    }
    if (pathname === WEBHOOK_PATH && request.method === 'POST') return handleWebhookRequest(request, env, rt);
    return new Response('not found', { status: 404 });
  },

  async queue(batch, env, _ctx) {
    const rt = runtime(env);
    const deps = consumerDeps(env, rt);
    // Messages are independent; run them side by side so one slow render
    // doesn't hold up the others in the batch.
    await Promise.all(
      batch.messages.map(async (message) => {
        try {
          const result = await processQueueMessage(message.body, tasks, deps);
          if (result.status === 'retry') message.retry({ delaySeconds: result.delaySeconds });
          else message.ack();
        } catch (err) {
          rt.logger.error('queue message crashed', { err });
          message.retry({ delaySeconds: 10 });
        }
      }),
    );
  },

  async scheduled(_controller, env, ctx) {
    const rt = runtime(env);
    ctx.waitUntil(
      Promise.all([
        new D1DedupeStore(env.DB).purgeExpired(),
        new D1NoticeStore(env.DB).purgeExpired(),
        new D1JobVersionStore(env.DB).purgeOlderThan(Date.now() - JOB_VERSION_RETENTION_MS),
      ]).then(([dedupe, notices, jobVersions]) => rt.logger.info('purged expired rows', { dedupe, notices, jobVersions })),
    );
  },
} satisfies ExportedHandler<Env, QueueMessage>;
