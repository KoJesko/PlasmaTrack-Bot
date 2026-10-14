import {
  ApplicationCommandType,
  ComponentType,
  InteractionType,
  type APIInteraction,
} from 'discord-api-types/v10';
import { createLogger, type LogLevel } from '../src/log.ts';
import {
  MemoryDedupeStore,
  MemoryJobVersionStore,
  MemoryNoticeStore,
  MemoryReviewPostStore,
  MemoryTokenGrantStore,
  MemoryWorkQueue,
} from '../src/memory.ts';
import type { Clock } from '../src/ports.ts';
import type { PlasmaTrackApi } from '../src/api/client.ts';
import type { GuildSettings } from '../src/config.ts';
import type { DiscordSender, QueueMessage } from '../src/interactions/types.ts';
import type { ConsumerDeps } from '../src/interactions/tasks.ts';
import type { RouterDeps } from '../src/interactions/router.ts';
import { handlers } from '../src/commands/index.ts';

export const APP_ID = '100000000000000001';
export const GUILD_ID = '200000000000000002';
export const MOD_ROLE = '300000000000000003';
export const MEMBER_ROLE = '300000000000000013';
export const BACKEND = 'production';
/** Test guild settings: one member role, one moderator role. */
export const GUILDS: Record<string, GuildSettings> = {
  [GUILD_ID]: { backend: BACKEND, member_roles: [MEMBER_ROLE], moderator_roles: [MOD_ROLE], review_channel: undefined },
};
export const USER_A = '400000000000000004';
export const USER_B = '500000000000000005';
export const INTERACTION_TOKEN = 'aW50ZXJhY3Rpb246MTIzNDU2Nzg5MDpzZWNyZXQtdG9rZW4';

export class FakeClock implements Clock {
  t = Date.UTC(2026, 8, 28, 12, 0, 0);
  now() {
    return this.t;
  }
}

export function captureLogger() {
  const lines: { level: LogLevel; line: string }[] = [];
  const logger = createLogger((level, line) => lines.push({ level, line }));
  return { logger, lines };
}

type Base = {
  guild?: boolean;
  roles?: string[];
  user?: string;
  options?: unknown[];
  globalName?: string;
  /** Interaction ID (idempotency keys derive from it). */
  id?: string;
  /** Form fields, for modal submissions. */
  fields?: Record<string, string>;
  /** Picked values, for select menus. */
  values?: string[];
  /** resolved.attachments, for commands with file options. */
  attachments?: Record<string, { url: string; size: number; filename: string }>;
};

function base(opts: Base) {
  const user = { id: opts.user ?? USER_A, username: 'driver', discriminator: '0', global_name: opts.globalName ?? null, avatar: null };
  const common = {
    id: opts.id ?? '600000000000000006',
    application_id: APP_ID,
    token: INTERACTION_TOKEN,
    version: 1,
    locale: 'en-US',
    app_permissions: '0',
    entitlements: [],
    authorizing_integration_owners: {},
    attachment_size_limit: 10 * 1024 * 1024,
  };
  return opts.guild === false
    ? { ...common, user, channel: { id: '1', type: 1 } }
    : {
        ...common,
        guild_id: GUILD_ID,
        guild_locale: 'en-US',
        channel: { id: '1', type: 0 },
        member: {
          user,
          // Members by default: every PlasmaTrack command needs a role.
          roles: opts.roles ?? [MEMBER_ROLE],
          permissions: '0',
          joined_at: '2026-01-01T00:00:00Z',
          deaf: false,
          mute: false,
          flags: 0,
        },
      };
}

export function commandInteraction(name: string, opts: Base = {}): APIInteraction {
  return {
    ...base(opts),
    type: InteractionType.ApplicationCommand,
    data: {
      id: '700000000000000007',
      name,
      type: ApplicationCommandType.ChatInput,
      options: opts.options ?? [],
      ...(opts.attachments ? { resolved: { attachments: opts.attachments } } : {}),
    },
  } as unknown as APIInteraction;
}

export function buttonInteraction(customId: string, opts: Base = {}): APIInteraction {
  return {
    ...base(opts),
    type: InteractionType.MessageComponent,
    message: { id: '1' },
    data: opts.values
      ? { custom_id: customId, component_type: 3, values: opts.values }
      : { custom_id: customId, component_type: ComponentType.Button },
  } as unknown as APIInteraction;
}

export function modalInteraction(customId: string, opts: Base = {}): APIInteraction {
  return {
    ...base(opts),
    type: InteractionType.ModalSubmit,
    data: {
      custom_id: customId,
      components: Object.entries(opts.fields ?? {}).map(([k, v]) => ({ type: 1, components: [{ type: 4, custom_id: k, value: v }] })),
    },
  } as unknown as APIInteraction;
}

export function routerDeps(overrides: Partial<RouterDeps> = {}) {
  const queue = new MemoryWorkQueue<QueueMessage>();
  const deps: RouterDeps = {
    handlers,
    applicationId: APP_ID,
    guilds: GUILDS,
    queue,
    logger: captureLogger().logger,
    clock: new FakeClock(),
    ...overrides,
  };
  return { deps, queue };
}

export type SentCall = { op: 'edit' | 'followup' | 'dm' | 'post' | 'edit-post'; target: string; message: unknown; files: unknown[] };

export class FakeDiscord implements DiscordSender {
  calls: SentCall[] = [];
  failNext: Error | null = null;

  private check() {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
  }
  async editOriginal(token: string, message: unknown, files: unknown[] = []) {
    this.check();
    this.calls.push({ op: 'edit', target: token, message, files });
  }
  async followup(token: string, message: unknown, files: unknown[] = []) {
    this.check();
    this.calls.push({ op: 'followup', target: token, message, files });
  }
  /** DMs to these users fail with the given error (e.g. DMs closed). */
  dmFailures = new Map<string, Error>();

  private nextMessage = 1;
  /** Channel message edits fail with this (e.g. a 404 for a deleted post). */
  editPostFailure: Error | null = null;

  async postChannelMessage(channelId: string, message: unknown) {
    this.check();
    this.calls.push({ op: 'post', target: channelId, message, files: [] });
    return `msg${this.nextMessage++}`;
  }
  async editChannelMessage(channelId: string, messageId: string, message: unknown) {
    this.check();
    if (this.editPostFailure) throw this.editPostFailure;
    this.calls.push({ op: 'edit-post', target: `${channelId}/${messageId}`, message, files: [] });
  }

  async sendDirectMessage(userId: string, message: unknown) {
    this.check();
    const fail = this.dmFailures.get(userId);
    if (fail) throw fail;
    this.calls.push({ op: 'dm', target: userId, message, files: [] });
  }
}

export function taskDeps(clock = new FakeClock()) {
  const discord = new FakeDiscord();
  const notices = new MemoryNoticeStore(clock);
  const { logger, lines } = captureLogger();
  const renderer = {
    renderRoute: async () => ({ bytes: new Uint8Array(), contentType: 'image/png', cached: false }),
    renderChart: async () => ({ bytes: new Uint8Array(), contentType: 'image/png', cached: false }),
  };
  const queue = new MemoryWorkQueue<QueueMessage>();
  const dedupe = new MemoryDedupeStore(clock);
  const jobVersions = new MemoryJobVersionStore(clock);
  const grants = new MemoryTokenGrantStore(clock);
  const reviewPosts = new MemoryReviewPostStore();
  /** Review channels of the test backend; tests may push to it. */
  const reviewChannels: string[] = [];
  /** The test guild's backend; tests set `backend.api` to connect it. */
  const backend: { name: string; api: PlasmaTrackApi | null } = { name: BACKEND, api: null };
  const deps: ConsumerDeps = {
    discord,
    notices,
    clock,
    logger,
    renderer,
    backends: {
      forGuild: (guildId) => (guildId && GUILDS[guildId] ? backend : null),
      byName: (name) => (name === backend.name ? backend.api : null),
    },
    grants,
    reviewPosts,
    reviewChannels: (name) => (name === backend.name ? reviewChannels : []),
    truckersmp: { player: async () => null },
    dedupe,
    jobVersions,
    queue,
    noticeTtlDays: 30,
  };
  return { deps, backend, discord, notices, clock, lines, queue, dedupe, jobVersions, grants, reviewPosts, reviewChannels };
}
