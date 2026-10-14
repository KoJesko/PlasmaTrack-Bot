import type {
  RESTPutAPIApplicationCommandsJSONBody,
  RESTPutAPIApplicationGuildCommandsJSONBody,
} from 'discord-api-types/v10';
import type { CommandDefinition } from '../interactions/types.ts';

export interface CommandRegistration {
  /**
   * Always empty: every command is registered per server, so nothing works in
   * DMs (owner's decision, 2026-10-14). PUTting [] removes earlier global commands.
   */
  global: RESTPutAPIApplicationCommandsJSONBody;
  /**
   * Registered in each configured server. Moderator commands are hidden from
   * non-admins until a server admin allows the moderator roles under Server
   * Settings → Integrations. The bot checks roles on every use either way.
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
    global: [],
    guild: commands.map((c) => (c.access === 'moderator' ? { ...c.json, default_member_permissions: '0' } : { ...c.json })),
  };
}
