// Registers the bot's slash commands with Discord (bulk overwrite).
//
//   npm run register-commands -w @plasmatrack/worker             # register
//   npm run register-commands -w @plasmatrack/worker -- --dry-run # print only
//
// Reads DISCORD_APPLICATION_ID, DISCORD_GUILD_ID and DISCORD_BOT_TOKEN from the
// environment, falling back to packages/worker/.dev.vars. The token is never printed.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildCommandRegistration, DISCORD_API, handlers } from '@plasmatrack/core';

function loadDevVars(): Record<string, string> {
  const file = join(import.meta.dirname, '..', '.dev.vars');
  if (!existsSync(file)) return {};
  const vars: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/.exec(line);
    if (m && !line.trimStart().startsWith('#')) vars[m[1]!] = m[2]!;
  }
  return vars;
}

const dryRun = process.argv.includes('--dry-run');
const vars = { ...loadDevVars(), ...process.env };
const registration = buildCommandRegistration(handlers.commands);

if (dryRun) {
  console.log(JSON.stringify(registration, null, 2));
  process.exit(0);
}

const missing = ['DISCORD_APPLICATION_ID', 'DISCORD_GUILD_ID', 'DISCORD_BOT_TOKEN'].filter((k) => !vars[k]);
if (missing.length > 0) {
  console.error(`Missing: ${missing.join(', ')} (set them in the environment or packages/worker/.dev.vars)`);
  process.exit(1);
}
const appId = vars['DISCORD_APPLICATION_ID']!;
const guildId = vars['DISCORD_GUILD_ID']!;

async function put(path: string, body: unknown, label: string): Promise<void> {
  const res = await fetch(DISCORD_API + path, {
    method: 'PUT',
    headers: { Authorization: `Bot ${vars['DISCORD_BOT_TOKEN']}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error(`${label}: Discord answered ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
  const names = ((await res.json()) as { name: string }[]).map((c) => c.name);
  console.log(`${label}: ${names.length} command(s): ${names.join(', ') || '(none)'}`);
}

await put(`/applications/${appId}/commands`, registration.global, 'global (guild + DMs)');
await put(`/applications/${appId}/guilds/${guildId}/commands`, registration.guild, `guild ${guildId} (moderators)`);
