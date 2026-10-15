import type { APIInteraction } from 'discord-api-types/v10';
import { describe, expect, it } from 'vitest';
import { PlasmaTrackApi } from '../src/api/client.ts';
import { tasks } from '../src/commands/index.ts';
import { handleInteraction } from '../src/interactions/router.ts';
import { processQueueMessage } from '../src/interactions/tasks.ts';
import type { QueueMessage } from '../src/interactions/types.ts';
import { commandInteraction, FakeClock, routerDeps, taskDeps } from './helpers.ts';
import { BASE_URL, BOT_TOKEN, MockPlasmaTrackServer, PLAYER_ID } from './mock-api.ts';

// /download (only the roles that may use the bot) and /uninstall (anyone), owner 2026-10-15.

const EPHEMERAL = 64;
type Sent = {
  content?: string;
  flags?: number;
  embeds?: { title?: string; description?: string; fields?: { name: string; value: string }[] }[];
  components?: { components: { style?: number; label?: string; url?: string }[] }[];
};

let nextId = 9500;
const id = () => String(830000000000000000n + BigInt(nextId++));

function setup() {
  const server = new MockPlasmaTrackServer();
  const t = taskDeps();
  t.backend.api = new PlasmaTrackApi({ baseUrl: BASE_URL, token: BOT_TOKEN, fetch: server.fetch });
  async function run(name: string, extra: Record<string, unknown> = {}) {
    const { deps, queue } = routerDeps({ clock: t.clock as FakeClock });
    const { response } = await handleInteraction(commandInteraction(name, { user: PLAYER_ID, id: id(), ...extra }) as APIInteraction, deps);
    const before = t.discord.calls.length;
    for (const m of queue.take().filter((x): x is Extract<QueueMessage, { type: 'interaction-task' }> => x.type === 'interaction-task')) {
      await processQueueMessage(m, tasks, t.deps);
    }
    const last = t.discord.calls.slice(before).filter((c) => c.op === 'edit').at(-1);
    return { response: response as { type: number; data?: Sent }, sent: last?.message as Sent | undefined };
  }
  return { server, run };
}

describe('/download', () => {
  it('gives a member a personal link, privately, with install steps and the SmartScreen note', async () => {
    const s = setup();
    const { response, sent } = await s.run('download');
    expect(response.data!.flags! & EPHEMERAL).toBeTruthy();
    expect(sent!.flags! & EPHEMERAL).toBeTruthy();
    const embed = sent!.embeds![0]!;
    expect(embed.title).toBe('PlasmaTrack 0.2.1 for Windows');
    expect(embed.description).toContain('`PlasmaTrack-Setup-0.2.1.exe` · 98.4 MB');
    expect(embed.description).toContain('More info');
    expect(embed.description).toContain('`/token new`');
    expect(embed.fields![0]).toEqual({ name: 'What’s new', value: 'Uploads resume faster after a network outage.' });
    const button = sent!.components![0]!.components[0]!;
    expect(button.style).toBe(5); // a link button
    expect(button.url).toContain(`/dl/releases/windows/0.2.1/PlasmaTrack-Setup-0.2.1.exe?exp=`);
    expect(button.url).toContain(PLAYER_ID); // personal (the mock signs with the player's ID)
  });

  it('is refused without an allowed role, before the server is asked', async () => {
    const s = setup();
    const { response } = await s.run('download', { roles: [] });
    expect(response.data!.content).toBeTruthy();
    expect(response.data!.flags! & EPHEMERAL).toBeTruthy();
    expect(s.server.calls).toHaveLength(0);
  });

  it('says when nothing is published yet, and when the account is blocked', async () => {
    const s = setup();
    s.server.client = null;
    expect((await s.run('download')).sent!.content).toBe('No PlasmaTrack Setup has been published yet. Ask a moderator.');

    const b = setup();
    b.server.players.get(PLAYER_ID)!.disabled = true;
    expect((await b.run('download')).sent!.content).toContain('blocked');
  });
});

describe('/uninstall', () => {
  it('works for anyone, with the public uninstaller link and the Installed apps route', async () => {
    const s = setup();
    const { sent } = await s.run('uninstall', { roles: [] });
    expect(sent!.flags ?? 0).toBe(0);
    const text = sent!.embeds![0]!.description!;
    expect(text).toContain('Installed apps');
    expect(text).toContain('download the uninstaller (1.6 MB)');
    const button = sent!.components![0]!.components[0]!;
    expect(button.style).toBe(5);
    expect(button.url).toMatch(/\/dl\/uninstall\/windows$/);
  });

  it('still explains Installed apps when no uninstaller is published', async () => {
    const s = setup();
    s.server.client = null;
    const { sent } = await s.run('uninstall', { options: [{ name: 'private', type: 5, value: true }] });
    expect(sent!.flags! & EPHEMERAL).toBeTruthy();
    expect(sent!.embeds![0]!.description).toContain('once one is published');
    expect(sent!.components).toBeUndefined();
  });
});
