import type {
  APIChatInputApplicationCommandInteraction,
  APIInteraction,
  APIInteractionResponse,
} from 'discord-api-types/v10';
import {
  ApplicationCommandType,
  InteractionResponseType,
  InteractionType,
  MessageFlags,
} from '../discord/constants.ts';
import type { GuildSettings } from '../config.ts';
import type { Logger } from '../log.ts';
import type { Clock, RateLimiter, WorkQueue } from '../ports.ts';
import type { OutgoingMessage } from '../discord/rest.ts';
import type {
  Access,
  HandlerResult,
  InteractionHandlers,
  InteractionRef,
  QueueMessage,
} from './types.ts';

export interface RouterDeps {
  handlers: InteractionHandlers;
  applicationId: string;
  /** Per Discord server: roles and backend. Commands outside these servers are refused. */
  guilds: Readonly<Record<string, GuildSettings>>;
  queue: WorkQueue<QueueMessage>;
  logger: Logger;
  clock: Clock;
  /**
   * How long the response waits for the enqueue. A slower enqueue doesn't fail the
   * command: the deferred response goes out and the enqueue finishes in `after`.
   */
  enqueueTimeoutMs?: number;
  /** Tells the user a command could not be started after its deferred response went out. */
  reportStartFailure?: (interaction: InteractionRef, kind: 'defer' | 'defer-update') => Promise<void>;
  /** Per-user budget for slash commands (all users; buttons and forms don't count). */
  limiter?: RateLimiter;
  /** Upper bound on the limiter check; when it is slow or down, the user goes ahead. */
  limiterTimeoutMs?: number;
}

export interface RouterResult {
  response: APIInteractionResponse;
  /** Work to enqueue after the response is sent (never awaited before responding). */
  background: QueueMessage[];
  /** A slow enqueue still in flight when the response went out; keep the Worker alive for it. */
  after?: Promise<void>;
}

export const NOT_ALLOWED = 'You need a moderator role to use this.';
export const NOT_MEMBER = 'PlasmaTrack isn’t open to your roles here. Ask a moderator if you think you should have access.';
export const NOT_HERE = 'PlasmaTrack commands only work in its Discord servers.';
export const START_FAILED = 'Sorry, that could not be started. Please try again in a moment.';
export const RATE_LIMITED = 'You’re going a bit fast. Please wait a few seconds and try again.';

/** The interaction ID is in every related log line, so users can quote it. */
export const withReference = (text: string, interactionId: string) => `${text} (Reference: ${interactionId})`;

export async function handleInteraction(interaction: APIInteraction, deps: RouterDeps): Promise<RouterResult> {
  if (interaction.type === InteractionType.Ping) {
    return { response: { type: InteractionResponseType.Pong }, background: [] };
  }
  if (interaction.type === InteractionType.ApplicationCommandAutocomplete) {
    // Autocomplete can't be deferred; nothing uses it yet.
    return {
      response: { type: InteractionResponseType.ApplicationCommandAutocompleteResult, data: { choices: [] } },
      background: [],
    };
  }

  const userId = interaction.member?.user.id ?? interaction.user?.id;
  if (!userId) return reply(ephemeralText('Could not identify you.'));
  const ref: InteractionRef = {
    id: interaction.id,
    applicationId: interaction.application_id,
    token: interaction.token,
    userId,
    receivedAt: deps.clock.now(),
    ...(interaction.guild_id ? { guildId: interaction.guild_id } : {}),
  };

  let access: Access;
  let run: () => HandlerResult;
  let isCommand = false;

  if (interaction.type === InteractionType.ApplicationCommand) {
    if (interaction.data.type !== ApplicationCommandType.ChatInput) {
      return reply(ephemeralText('Unsupported command type.'));
    }
    const chat = interaction as APIChatInputApplicationCommandInteraction;
    const command = deps.handlers.commands.find((c) => c.json.name === chat.data.name);
    if (!command) return reply(ephemeralText('Unknown command.'));
    access = command.access;
    run = () => command.handle({ interaction: chat, userId });
    isCommand = true;
  } else if (interaction.type === InteractionType.MessageComponent) {
    const [prefix, arg] = splitCustomId(interaction.data.custom_id);
    const component = deps.handlers.components.find((c) => c.prefix === prefix);
    if (!component) return reply(ephemeralText('This button is no longer supported.'));
    access = component.access;
    run = () => component.handle({ interaction, userId }, arg);
  } else if (interaction.type === InteractionType.ModalSubmit) {
    const [prefix, arg] = splitCustomId(interaction.data.custom_id);
    const modal = deps.handlers.modals.find((m) => m.prefix === prefix);
    if (!modal) return reply(ephemeralText('This form is no longer supported.'));
    access = modal.access;
    run = () => modal.handle({ interaction, userId }, arg);
  } else {
    return reply(ephemeralText('Unsupported interaction.'));
  }

  if (access !== 'public') {
    const guild = interaction.guild_id ? deps.guilds[interaction.guild_id] : undefined;
    if (!guild || !interaction.member) return reply(ephemeralText(NOT_HERE));
    if (access === 'moderator' && !isModerator(interaction, guild)) return reply(ephemeralText(NOT_ALLOWED));
    if (access === 'member' && !isMember(interaction, guild)) return reply(ephemeralText(NOT_MEMBER));
  }

  if (isCommand && deps.limiter) {
    let allowed = true;
    try {
      allowed = await withTimeout(deps.limiter.allow(userId), deps.limiterTimeoutMs ?? 500);
    } catch (err) {
      deps.logger.warn('rate limiter unavailable; allowing', { err });
    }
    if (!allowed) {
      deps.logger.info('rate limited', { userId, interactionId: interaction.id });
      return reply(ephemeralText(RATE_LIMITED));
    }
  }

  let result: HandlerResult;
  try {
    result = run();
  } catch (err) {
    deps.logger.error('handler threw', { err, interactionId: interaction.id });
    return reply(ephemeralText(withReference('Something went wrong handling that.', interaction.id)));
  }

  // Notices belong to a server's backend, so the hint only makes sense inside a configured server.
  const inGuild = !!(interaction.guild_id && deps.guilds[interaction.guild_id]);
  const hint: QueueMessage[] = isCommand && inGuild ? [{ type: 'notice-hint', interaction: ref }] : [];

  switch (result.kind) {
    case 'reply':
      return {
        response: {
          type: InteractionResponseType.ChannelMessageWithSource,
          data: messageData(result.message, result.ephemeral),
        },
        background: hint,
      };
    case 'modal':
      return { response: { type: InteractionResponseType.Modal, data: result.modal }, background: [] };
    case 'update':
      return {
        response: {
          type: InteractionResponseType.UpdateMessage,
          data: { allowed_mentions: { parse: [] }, ...result.message },
        },
        background: [],
      };
    case 'defer':
    case 'defer-update': {
      const message: QueueMessage = { type: 'interaction-task', task: result.task, interaction: ref, noticeHint: isCommand && inGuild };
      const log = { task: result.task.name, interactionId: interaction.id };
      // Queue sends are usually fast but sometimes take seconds. Waiting past Discord's
      // 3 s would lose the command, so a slow send carries on after the response.
      const sending = deps.queue.send(message);
      let after: Promise<void> | undefined;
      try {
        await withTimeout(sending, deps.enqueueTimeoutMs ?? 1000);
      } catch (err) {
        if (!(err instanceof EnqueueTimeout)) {
          deps.logger.error('enqueue failed', { ...log, err });
          return reply(ephemeralText(withReference(START_FAILED, interaction.id)));
        }
        deps.logger.warn('enqueue slow; answering first', log);
        const kind = result.kind;
        after = sending
          .catch(() => deps.queue.send(message))
          .catch(async (err: unknown) => {
            deps.logger.error('enqueue failed', { ...log, err });
            await deps.reportStartFailure?.(ref, kind);
          })
          .catch((err: unknown) => deps.logger.error('start failure not reported', { ...log, err }));
      }
      const response: APIInteractionResponse =
        result.kind === 'defer'
          ? {
              type: InteractionResponseType.DeferredChannelMessageWithSource,
              data: result.ephemeral ? { flags: MessageFlags.Ephemeral } : {},
            }
          : { type: InteractionResponseType.DeferredMessageUpdate };
      return { response, background: [], ...(after ? { after } : {}) };
    }
  }
}

/** `member.roles` only exists for interactions in a guild; the caller has checked the guild is configured. */
export function isModerator(interaction: APIInteraction, guild: GuildSettings): boolean {
  return !!interaction.member?.roles.some((r) => guild.moderator_roles.includes(r));
}

/** Members need a member role; moderators can always use member commands. */
export function isMember(interaction: APIInteraction, guild: GuildSettings): boolean {
  return isModerator(interaction, guild) || !!interaction.member?.roles.some((r) => guild.member_roles.includes(r));
}

export function splitCustomId(customId: string): [string, string] {
  const i = customId.indexOf(':');
  return i === -1 ? [customId, ''] : [customId.slice(0, i), customId.slice(i + 1)];
}

export function ephemeralText(content: string): OutgoingMessage {
  return { content, flags: MessageFlags.Ephemeral };
}

function messageData(message: OutgoingMessage, ephemeral: boolean): OutgoingMessage {
  const flags = (message.flags ?? 0) | (ephemeral ? MessageFlags.Ephemeral : 0);
  return { allowed_mentions: { parse: [] }, ...message, ...(flags ? { flags } : {}) };
}

function reply(message: OutgoingMessage): RouterResult {
  return {
    response: {
      type: InteractionResponseType.ChannelMessageWithSource,
      data: messageData(message, ((message.flags ?? 0) & MessageFlags.Ephemeral) !== 0),
    },
    background: [],
  };
}

class EnqueueTimeout extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new EnqueueTimeout(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
