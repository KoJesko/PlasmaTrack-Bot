import {
  ApplicationIntegrationType,
  InteractionContextType,
  type RESTPutAPIApplicationCommandsJSONBody,
  type RESTPutAPIApplicationGuildCommandsJSONBody,
} from 'discord-api-types/v10';
import type { CommandDefinition } from '../interactions/types.ts';

export interface CommandRegistration {
  /** Player commands: usable in the guild and in DMs with the bot. */
  global: RESTPutAPIApplicationCommandsJSONBody;
  /**
   * Moderator commands: registered only in the PlasmaTrack guild, so they can
   * never be used in DMs. Hidden from non-admins until a server admin allows the
   * moderator role under Server Settings → Integrations. The bot re-checks the
   * role on every use.
   */
  guild: RESTPutAPIApplicationGuildCommandsJSONBody;
}

export function buildCommandRegistration(commands: readonly CommandDefinition[]): CommandRegistration {
  const names = new Set<string>();
  for (const c of commands) {
    if (names.has(c.json.name)) throw new Error(`duplicate command name: ${c.json.name}`);
    names.add(c.json.name);
  }
  return {
    global: commands
      .filter((c) => c.access === 'everyone')
      .map((c) => ({
        ...c.json,
        contexts: [InteractionContextType.Guild, InteractionContextType.BotDM],
        integration_types: [ApplicationIntegrationType.GuildInstall],
      })),
    guild: commands
      .filter((c) => c.access === 'moderator')
      .map((c) => ({ ...c.json, default_member_permissions: '0' })),
  };
}
