import {
  InteractionResponseType,
  InteractionType,
  MessageFlags,
  type APIChatInputApplicationCommandInteraction,
  type APIInteraction,
  type APIInteractionResponse,
  ApplicationCommandType,
} from 'discord-api-types/v10';
import type { Logger } from '../log.ts';
import type { Clock, WorkQueue } from '../ports.ts';
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
  guildId: string;
  moderatorRoleIds: readonly string[];
  queue: WorkQueue<QueueMessage>;
  logger: Logger;
  clock: Clock;
  /** Upper bound on the only await in the response path. Keeps us inside Discord's 3 s. */
  enqueueTimeoutMs?: number;
}

export interface RouterResult {
  response: APIInteractionResponse;
  /** Work to enqueue after the response is sent (never awaited before responding). */
  background: QueueMessage[];
}

export const NOT_ALLOWED = 'You need a moderator role in the PlasmaTrack server to use this.';
export const START_FAILED = 'Sorry, that could not be started. Please try again in a moment.';

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

  if (access === 'moderator' && !isModerator(interaction, deps)) {
    return reply(ephemeralText(NOT_ALLOWED));
  }

  let result: HandlerResult;
  try {
    result = run();
  } catch (err) {
    deps.logger.error('handler threw', { err, interactionId: interaction.id });
    return reply(ephemeralText('Something went wrong handling that.'));
  }

  const hint: QueueMessage[] = isCommand ? [{ type: 'notice-hint', interaction: ref }] : [];

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
    case 'defer':
    case 'defer-update': {
      const message: QueueMessage = { type: 'interaction-task', task: result.task, interaction: ref, noticeHint: isCommand };
      try {
        await withTimeout(deps.queue.send(message), deps.enqueueTimeoutMs ?? 2000);
      } catch (err) {
        deps.logger.error('enqueue failed', { err, task: result.task.name });
        return reply(ephemeralText(START_FAILED));
      }
      const response: APIInteractionResponse =
        result.kind === 'defer'
          ? {
              type: InteractionResponseType.DeferredChannelMessageWithSource,
              data: result.ephemeral ? { flags: MessageFlags.Ephemeral } : {},
            }
          : { type: InteractionResponseType.DeferredMessageUpdate };
      return { response, background: [] };
    }
  }
}

/**
 * Moderator commands are registered only in the configured guild, and are
 * also refused here unless used inside that guild by a member holding a
 * moderator role. `member.roles` only exists for interactions in a guild.
 */
export function isModerator(
  interaction: APIInteraction,
  deps: Pick<RouterDeps, 'guildId' | 'moderatorRoleIds'>,
): boolean {
  if (interaction.guild_id !== deps.guildId || !interaction.member) return false;
  return interaction.member.roles.some((r) => deps.moderatorRoleIds.includes(r));
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

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
