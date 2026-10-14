import {
  ApplicationCommandType,
  ComponentType,
  InteractionType,
  type APIInteraction,
} from 'discord-api-types/v10';
import { createLogger, type LogLevel } from '../src/log.ts';
import { MemoryNoticeStore, MemoryWorkQueue } from '../src/memory.ts';
import type { Clock } from '../src/ports.ts';
import type { DiscordSender, QueueMessage, TaskDeps } from '../src/interactions/types.ts';
import type { RouterDeps } from '../src/interactions/router.ts';
import { handlers } from '../src/commands/index.ts';

export const APP_ID = '100000000000000001';
export const GUILD_ID = '200000000000000002';
export const MOD_ROLE = '300000000000000003';
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

type Base = { guild?: boolean; roles?: string[]; user?: string };

function base(opts: Base) {
  const user = { id: opts.user ?? USER_A, username: 'driver', discriminator: '0', global_name: null, avatar: null };
  const common = {
    id: '600000000000000006',
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
          roles: opts.roles ?? [],
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
    data: { id: '700000000000000007', name, type: ApplicationCommandType.ChatInput, options: [] },
  } as unknown as APIInteraction;
}

export function buttonInteraction(customId: string, opts: Base = {}): APIInteraction {
  return {
    ...base(opts),
    type: InteractionType.MessageComponent,
    message: { id: '1' },
    data: { custom_id: customId, component_type: ComponentType.Button },
  } as unknown as APIInteraction;
}

export function modalInteraction(customId: string, opts: Base = {}): APIInteraction {
  return {
    ...base(opts),
    type: InteractionType.ModalSubmit,
    data: { custom_id: customId, components: [] },
  } as unknown as APIInteraction;
}

export function routerDeps(overrides: Partial<RouterDeps> = {}) {
  const queue = new MemoryWorkQueue<QueueMessage>();
  const deps: RouterDeps = {
    handlers,
    applicationId: APP_ID,
    guildId: GUILD_ID,
    moderatorRoleIds: [MOD_ROLE],
    queue,
    logger: captureLogger().logger,
    clock: new FakeClock(),
    ...overrides,
  };
  return { deps, queue };
}

export type SentCall = { op: 'edit' | 'followup' | 'dm'; target: string; message: unknown; files: unknown[] };

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
  async sendDirectMessage(userId: string, message: unknown) {
    this.check();
    this.calls.push({ op: 'dm', target: userId, message, files: [] });
  }
}

export function taskDeps(clock = new FakeClock()) {
  const discord = new FakeDiscord();
  const notices = new MemoryNoticeStore(clock);
  const { logger, lines } = captureLogger();
  const deps: TaskDeps = { discord, notices, clock, logger };
  return { deps, discord, notices, clock, lines };
}
