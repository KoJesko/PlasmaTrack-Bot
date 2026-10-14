import type {
  APIApplicationCommandBooleanOption,
  APIApplicationCommandInteractionDataOption,
  APIApplicationCommandStringOption,
  APIChatInputApplicationCommandInteraction,
  APIInteraction,
  APIUser,
} from 'discord-api-types/v10';
import { ApplicationCommandOptionType } from '../discord/constants.ts';

// Reading slash-command options. Discord nests a subcommand's options one
// level down; these helpers look at the leaf options either way.

type Option = APIApplicationCommandInteractionDataOption;

export function subcommand(i: APIChatInputApplicationCommandInteraction): string | undefined {
  const first = i.data.options?.[0];
  return first?.type === ApplicationCommandOptionType.Subcommand ? first.name : undefined;
}

function leafOptions(i: APIChatInputApplicationCommandInteraction): Option[] {
  const opts = i.data.options ?? [];
  const first = opts[0];
  if (first?.type === ApplicationCommandOptionType.Subcommand) return (first.options ?? []) as Option[];
  return opts as Option[];
}

function raw(i: APIChatInputApplicationCommandInteraction, name: string): unknown {
  const o = leafOptions(i).find((x) => x.name === name);
  return o && 'value' in o ? o.value : undefined;
}

export function stringOption(i: APIChatInputApplicationCommandInteraction, name: string): string | undefined {
  const v = raw(i, name);
  return typeof v === 'string' ? v : undefined;
}

export function booleanOption(i: APIChatInputApplicationCommandInteraction, name: string): boolean | undefined {
  const v = raw(i, name);
  return typeof v === 'boolean' ? v : undefined;
}

/** A user option's ID (Discord validates it and includes the user in `resolved`). */
export function userOption(i: APIChatInputApplicationCommandInteraction, name: string): string | undefined {
  const v = raw(i, name);
  return typeof v === 'string' && /^\d{17,20}$/.test(v) ? v : undefined;
}

/** The user who triggered the interaction. */
export function invoker(i: APIInteraction): APIUser | undefined {
  return i.member?.user ?? i.user;
}

/** A display name for a new PlasmaTrack account: 2–32 characters, as the server requires. */
export function defaultDisplayName(user: APIUser | undefined): string {
  const name = (user?.global_name ?? user?.username ?? '').trim().slice(0, 32);
  return name.length >= 2 ? name : 'Player';
}

/** The common `private` option: replies are public unless it is true. */
export const PRIVATE_OPTION: APIApplicationCommandBooleanOption = {
  type: ApplicationCommandOptionType.Boolean,
  name: 'private',
  description: 'Only you see the reply (default: everyone in the channel sees it)',
  required: false,
};

export const GAME_OPTION: APIApplicationCommandStringOption = {
  type: ApplicationCommandOptionType.String,
  name: 'game',
  description: 'Euro Truck Simulator 2 or American Truck Simulator',
  required: true,
  choices: [
    { name: 'Euro Truck Simulator 2', value: 'ets2' },
    { name: 'American Truck Simulator', value: 'ats' },
  ],
};
