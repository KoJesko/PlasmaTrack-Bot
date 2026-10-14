import type * as D from 'discord-api-types/v10';

// Discord's numeric constants, typed against discord-api-types. Only types are
// taken from that package: its runtime enums are CommonJS, which does not load
// cleanly in every runtime (it came out `undefined` under workerd).

export const InteractionType = {
  Ping: 1 as D.InteractionType.Ping,
  ApplicationCommand: 2 as D.InteractionType.ApplicationCommand,
  MessageComponent: 3 as D.InteractionType.MessageComponent,
  ApplicationCommandAutocomplete: 4 as D.InteractionType.ApplicationCommandAutocomplete,
  ModalSubmit: 5 as D.InteractionType.ModalSubmit,
} as const;

export const InteractionResponseType = {
  Pong: 1 as D.InteractionResponseType.Pong,
  ChannelMessageWithSource: 4 as D.InteractionResponseType.ChannelMessageWithSource,
  DeferredChannelMessageWithSource: 5 as D.InteractionResponseType.DeferredChannelMessageWithSource,
  DeferredMessageUpdate: 6 as D.InteractionResponseType.DeferredMessageUpdate,
  UpdateMessage: 7 as D.InteractionResponseType.UpdateMessage,
  ApplicationCommandAutocompleteResult: 8 as D.InteractionResponseType.ApplicationCommandAutocompleteResult,
  Modal: 9 as D.InteractionResponseType.Modal,
} as const;

export const ApplicationCommandType = {
  ChatInput: 1 as D.ApplicationCommandType.ChatInput,
} as const;

export const InteractionContextType = {
  Guild: 0 as D.InteractionContextType.Guild,
  BotDM: 1 as D.InteractionContextType.BotDM,
} as const;

export const ApplicationIntegrationType = {
  GuildInstall: 0 as D.ApplicationIntegrationType.GuildInstall,
} as const;

export const ApplicationCommandOptionType = {
  Subcommand: 1 as D.ApplicationCommandOptionType.Subcommand,
  String: 3 as D.ApplicationCommandOptionType.String,
  Integer: 4 as D.ApplicationCommandOptionType.Integer,
  Boolean: 5 as D.ApplicationCommandOptionType.Boolean,
  User: 6 as D.ApplicationCommandOptionType.User,
} as const;

export const ComponentType = {
  ActionRow: 1 as D.ComponentType.ActionRow,
  Button: 2 as D.ComponentType.Button,
} as const;

export const ButtonStyle = {
  Primary: 1 as D.ButtonStyle.Primary,
  Secondary: 2 as D.ButtonStyle.Secondary,
  Danger: 4 as D.ButtonStyle.Danger,
} as const;

export const MessageFlags = {
  Ephemeral: (1 << 6) as D.MessageFlags.Ephemeral,
} as const;
