import {
  ConfigError,
  createLogger,
  DiscordRest,
  handleInteraction,
  handlers,
  parseBotConfig,
  processQueueMessage,
  secretValues,
  systemClock,
  tasks,
  verifyDiscordSignature,
  type BotConfig,
  type Logger,
  type QueueMessage,
  type TaskDeps,
} from '@plasmatrack/core';
import type { APIInteraction } from 'discord-api-types/v10';
import { CloudflareWorkQueue, D1DedupeStore, D1NoticeStore } from './adapters.ts';
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

function taskDeps(env: Env, rt: Runtime): TaskDeps {
  return {
    discord: new DiscordRest({ applicationId: rt.config.DISCORD_APPLICATION_ID, botToken: rt.config.DISCORD_BOT_TOKEN }),
    notices: new D1NoticeStore(env.DB),
    clock: systemClock,
    logger: rt.logger,
  };
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
    guildId: rt.config.DISCORD_GUILD_ID,
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
    return new Response('not found', { status: 404 });
  },

  async queue(batch, env) {
    const rt = runtime(env);
    const deps = taskDeps(env, rt);
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
      Promise.all([new D1DedupeStore(env.DB).purgeExpired(), new D1NoticeStore(env.DB).purgeExpired()]).then(
        ([dedupe, notices]) => rt.logger.info('purged expired rows', { dedupe, notices }),
      ),
    );
  },
} satisfies ExportedHandler<Env, QueueMessage>;
