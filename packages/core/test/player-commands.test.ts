import type { APIInteraction } from 'discord-api-types/v10';
import { describe, expect, it } from 'vitest';
import { PlasmaTrackApi } from '../src/api/client.ts';
import { NOT_CONNECTED } from '../src/api/errors.ts';
import { tasks } from '../src/commands/index.ts';
import { handleInteraction } from '../src/interactions/router.ts';
import { processQueueMessage } from '../src/interactions/tasks.ts';
import type { QueueMessage } from '../src/interactions/types.ts';
import { checkTruckersMpAccounts, TruckersMpClient } from '../src/truckersmp/client.ts';
import { MemoryBlobCache } from '../src/memory.ts';
import { buttonInteraction, commandInteraction, FakeClock, routerDeps, taskDeps } from './helpers.ts';
import { BASE_URL, BOT_TOKEN, MockPlasmaTrackServer, OTHER_ID, PLAYER_ID } from './mock-api.ts';

const EPHEMERAL = 64;

type Sent = { content?: string; flags?: number; embeds?: { title?: string; description?: string; fields?: { name: string; value: string }[]; image?: { url: string }; footer?: { text: string } }[]; components?: { components: { custom_id: string; label: string }[] }[] };

function setup(opts: { connected?: boolean; renderFails?: boolean; routeStatus?: number; truckersmp?: Record<number, string | null> } = {}) {
  const server = new MockPlasmaTrackServer();
  const t = taskDeps();
  const fetch: typeof server.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (opts.routeStatus && url.endsWith('/route')) {
      const body = { error: { code: 'not_implemented', message: 'not implemented', details: {} } };
      return new Response(JSON.stringify(body), { status: opts.routeStatus, headers: { 'content-type': 'application/json' } });
    }
    return server.fetch(input, init);
  };
  if (opts.connected !== false) t.backend.api = new PlasmaTrackApi({ baseUrl: BASE_URL, token: BOT_TOKEN, fetch });
  const renders: unknown[] = [];
  t.deps.renderer = {
    renderRoute: async (req) => {
      renders.push(req);
      if (opts.renderFails) throw new Error('renderer unreachable');
      return { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), contentType: 'image/png', cached: false };
    },
    renderChart: async () => {
      throw new Error('unused');
    },
    renderBars: async () => {
      throw new Error('unused');
    },
  };
  if (opts.truckersmp) {
    const tmp = opts.truckersmp;
    t.deps.truckersmp = {
      player: async (id) => (id in tmp ? { accountId: id, name: `TMP${id}`, discordId: tmp[id] ?? null, banned: false } : null),
    };
  }

  /** Runs an interaction the way the Worker does: router first, then any queued task. */
  async function run(interaction: APIInteraction) {
    const { deps, queue } = routerDeps({ clock: t.clock as FakeClock });
    const { response } = await handleInteraction(interaction, deps);
    const queued = queue.take().filter((m): m is Extract<QueueMessage, { type: 'interaction-task' }> => m.type === 'interaction-task');
    for (const m of queued) await processQueueMessage(m, tasks, t.deps);
    const edits = t.discord.calls.filter((c) => c.op === 'edit');
    const last = edits.at(-1);
    return {
      response: response as { type: number; data?: Sent & { flags?: number } },
      sent: last?.message as Sent | undefined,
      files: (last?.files ?? []) as { name: string }[],
    };
  }
  return { server, run, renders, ...t };
}

const opt = (name: string, value: unknown, type = 3) => ({ name, type, value });
const sub = (name: string, options: unknown[] = []) => ({ name, type: 1, options });
const text = (m: Sent | undefined) => JSON.stringify(m ?? {});

describe('/token', () => {
  it('links a new player and shows the token once, privately', async () => {
    const { run, server } = setup();
    const { response, sent } = await run(commandInteraction('token', { user: OTHER_ID, globalName: 'Newcomer', options: [sub('new')] }));
    expect(response).toEqual({ type: 5, data: { flags: EPHEMERAL } });
    expect(sent!.flags! & EPHEMERAL).toBe(EPHEMERAL);
    expect(sent!.content).toContain('Your PlasmaTrack account is linked');
    expect(sent!.content).toMatch(/```\npt_live_mock_tok_\d+_plaintext\n```/);
    expect(server.players.get(OTHER_ID)!.display_name).toBe('Newcomer');
    const call = server.calls.find((c) => c.method === 'POST')!;
    expect(call.path).toBe(`/api/v1/players/${OTHER_ID}/token`);
    expect(call.headers['idempotency-key']).toBe('600000000000000006:token.new');
  });

  it('asks before replacing an existing token, then replaces it on confirm', async () => {
    const { run, server } = setup();
    const first = await run(commandInteraction('token', { user: PLAYER_ID, options: [sub('new')] }));
    expect(first.sent!.content).toContain('You already have a token');
    expect(server.calls.some((c) => c.method === 'POST')).toBe(false);
    const confirmId = first.sent!.components![0]!.components[0]!.custom_id;
    expect(confirmId).toBe('tok-new');

    const confirmed = await run(buttonInteraction(confirmId, { user: PLAYER_ID }));
    expect(confirmed.response.type).toBe(6);
    expect(confirmed.sent!.content).toContain('shown only this once');
    expect(confirmed.sent!.components).toEqual([]);
  });

  it('cancel changes nothing', async () => {
    const { run, server } = setup();
    const { response } = await run(buttonInteraction('tok-cancel', { user: PLAYER_ID }));
    expect(response).toMatchObject({ type: 7, data: { content: 'Cancelled. Nothing changed.', components: [] } });
    expect(server.calls).toHaveLength(0);
  });

  it('never logs or queues the plaintext token', async () => {
    const { run, lines, queue } = setup();
    const { sent } = await run(commandInteraction('token', { user: OTHER_ID, options: [sub('new')] }));
    const token = /pt_live_\S+/.exec(sent!.content!)![0];
    expect(lines.some((l) => l.line.includes(token))).toBe(false);
    expect(JSON.stringify(queue.items)).not.toContain(token);
  });

  it('a replayed issue (e.g. after a retry) explains instead of failing', async () => {
    const { run } = setup();
    await run(commandInteraction('token', { user: OTHER_ID, options: [sub('new')] }));
    const again = await run(commandInteraction('token', { user: OTHER_ID, options: [sub('new')] }));
    // Same interaction ID → same idempotency key: the server replays without the plaintext.
    expect(again.sent!.content).toContain('You already have a token');
    // The button carries the same interaction ID in this test, so the server replays the first issue.
    const replay = await run(buttonInteraction('tok-new', { user: OTHER_ID }));
    expect(replay.sent!.content).toContain('couldn’t be shown');
    expect(replay.sent!.content).not.toMatch(/pt_live_/);
  });

  it('status and revoke', async () => {
    const { run } = setup();
    const status = await run(commandInteraction('token', { user: PLAYER_ID, options: [sub('status')] }));
    expect(status.sent!.content).toMatch(/^Your token was made <t:\d+:f> and last used <t:\d+:R>\.$/);

    const ask = await run(commandInteraction('token', { user: PLAYER_ID, options: [sub('revoke')] }));
    expect(ask.response.type).toBe(4);
    expect(ask.response.data!.flags! & EPHEMERAL).toBe(EPHEMERAL);
    const revoked = await run(buttonInteraction('tok-revoke', { user: PLAYER_ID }));
    expect(revoked.sent!.content).toContain('Your token is revoked');

    const after = await run(commandInteraction('token', { user: PLAYER_ID, options: [sub('status')] }));
    expect(after.sent!.content).toContain('haven’t linked');
  });

  it('says so when the server is not connected yet', async () => {
    const { run } = setup({ connected: false });
    const { sent } = await run(commandInteraction('token', { user: PLAYER_ID, options: [sub('status')] }));
    expect(sent!.content).toBe(NOT_CONNECTED);
  });
});

describe('/name', () => {
  it('changes the display name, privately', async () => {
    const { run, server } = setup();
    const { response, sent } = await run(commandInteraction('name', { user: PLAYER_ID, options: [opt('name', '  Plasma Driver ')] }));
    expect(response.data!.flags).toBe(EPHEMERAL);
    expect(sent!.content).toContain('**Plasma Driver**');
    expect(server.players.get(PLAYER_ID)!.display_name).toBe('Plasma Driver');
  });

  it('a player who is not linked is told how to link', async () => {
    const { run } = setup();
    const { sent } = await run(commandInteraction('name', { user: OTHER_ID, options: [opt('name', 'Somebody')] }));
    expect(sent!.content).toContain('/token new');
  });
});

describe('/profile', () => {
  it('is public by default and private on request', async () => {
    const { run } = setup();
    const pub = await run(commandInteraction('profile', { user: PLAYER_ID }));
    expect(pub.response).toEqual({ type: 5, data: {} });
    expect(pub.sent!.flags).toBe(0);
    const priv = await run(commandInteraction('profile', { user: PLAYER_ID, options: [opt('private', true, 5)] }));
    expect(priv.response).toEqual({ type: 5, data: { flags: EPHEMERAL } });
    expect(priv.sent!.flags).toBe(EPHEMERAL);
  });

  it('shows each game separately, miles first with km in brackets', async () => {
    const { run } = setup();
    const { sent } = await run(commandInteraction('profile', { user: PLAYER_ID }));
    const [ets2, ats] = sent!.embeds![0]!.fields!;
    expect(ets2!.name).toBe('Euro Truck Simulator 2');
    expect(ets2!.value).toContain('**7** points from 1 job');
    expect(ets2!.value).toContain('Driven (1:1): 7.07 mi (11.38 km)');
    expect(ets2!.value).toContain('1 in review');
    expect(ats!.name).toBe('American Truck Simulator');
  });

  it('shows another player’s profile, or says they are not linked', async () => {
    const { run } = setup();
    const { sent } = await run(commandInteraction('profile', { user: OTHER_ID, options: [opt('user', PLAYER_ID, 6)] }));
    expect(sent!.embeds![0]!.title).toBe('KoJesko');
    const none = await run(commandInteraction('profile', { user: PLAYER_ID, options: [opt('user', OTHER_ID, 6)] }));
    expect(none.sent!.content).toBe(`<@${OTHER_ID}> hasn’t linked PlasmaTrack.`);
  });

  it('shows TruckersMP accounts confirmed by TruckersMP to everyone, unconfirmed ones only to the player privately', async () => {
    const { run, server } = setup({ truckersmp: { 111: PLAYER_ID, 222: '999999999999999999' } });
    server.truckersmpAccounts.set(PLAYER_ID, [111, 222, 333]);
    const pub = await run(commandInteraction('profile', { user: OTHER_ID, options: [opt('user', PLAYER_ID, 6)] }));
    const pubTmp = pub.sent!.embeds![0]!.fields!.find((f) => f.name === 'TruckersMP')!;
    expect(pubTmp.value).toContain('TMP111');
    expect(pubTmp.value).toContain('✓ linked to this Discord account on TruckersMP');
    expect(pubTmp.value).not.toContain('TMP222');

    const own = await run(commandInteraction('profile', { user: PLAYER_ID, options: [opt('private', true, 5)] }));
    const ownTmp = own.sent!.embeds![0]!.fields!.find((f) => f.name === 'TruckersMP')!;
    expect(ownTmp.value).toContain('TMP222');
    expect(ownTmp.value).toContain('doesn’t show your Discord account');
    expect(ownTmp.value).toContain('couldn’t check');

    const ownPublic = await run(commandInteraction('profile', { user: PLAYER_ID }));
    expect(text(ownPublic.sent)).not.toContain('TMP222');
  });
});

describe('/job', () => {
  it('rejects something that is not a job ID right away', async () => {
    const { run } = setup();
    const { response } = await run(commandInteraction('job', { options: [opt('id', 'hello')] }));
    expect(response.type).toBe(4);
    expect(response.data!.content).toContain('7K2M-9QXA');
  });

  it('shows details with the route map attached, miles first', async () => {
    const { run, renders } = setup();
    const { sent, files } = await run(commandInteraction('job', { options: [opt('id', '7k2m-9qxa')] }));
    const embed = sent!.embeds![0]!;
    expect(embed.title).toBe('Job 7K2M-9QXA · ETS2');
    expect(embed.description).toBe('**Vaccines**: Dover (EuroAcres) → Calais (LKW Log)');
    const field = (n: string) => embed.fields!.find((f) => f.name === n)?.value;
    expect(field('Outcome')).toBe('Valid');
    expect(field('Points')).toBe('7');
    expect(field('Driven (1:1)')).toBe('7.07 mi (11.38 km)');
    expect(field('In game')).toBe('78.11 mi (125.7 km)');
    expect(field('Distance by map scale')).toContain('City scale: 1.75 mi (2.81 km) driven, 5.24 mi (8.43 km) in game');
    expect(field('Distance by map scale')).toContain('Road scale (vanilla): 5.33 mi (8.57 km) driven, 72.87 mi (117.27 km) in game');
    expect(embed.image).toEqual({ url: 'attachment://route.png' });
    expect(embed.footer!.text).toContain('SCS Software');
    expect(files.map((f) => f.name)).toEqual(['route.png']);
    expect(renders).toHaveLength(1);
    expect(JSON.stringify(renders[0])).not.toContain('start_at');
  });

  it('shows the details without a map while the server cannot draw routes (501)', async () => {
    const { run, renders } = setup({ routeStatus: 501 });
    const { sent, files } = await run(commandInteraction('job', { options: [opt('id', '7K2M9QXA')] }));
    expect(sent!.embeds![0]!.title).toBe('Job 7K2M-9QXA · ETS2');
    expect(sent!.embeds![0]!.image).toBeUndefined();
    expect(files).toEqual([]);
    expect(renders).toHaveLength(0);
  });

  it('still answers when the renderer is down, just without the map', async () => {
    const { run, lines } = setup({ renderFails: true });
    const { sent, files } = await run(commandInteraction('job', { options: [opt('id', '7K2M9QXA')] }));
    expect(sent!.embeds![0]!.image).toBeUndefined();
    expect(sent!.embeds![0]!.footer!.text).toContain('isn’t available');
    expect(files).toEqual([]);
    expect(lines.some((l) => l.level === 'warn' && l.line.includes('route image unavailable'))).toBe(true);
  });

  it('a job in review shows its held points; an unknown ID says so', async () => {
    const { run } = setup();
    const review = await run(commandInteraction('job', { options: [opt('id', 'R3VW5T6Y'), opt('private', true, 5)] }));
    expect(review.sent!.flags).toBe(EPHEMERAL);
    expect(review.sent!.embeds![0]!.fields!.find((f) => f.name === 'Points')!.value).toBe('90.3 (held for review)');
    const missing = await run(commandInteraction('job', { options: [opt('id', 'ZZZZZZZZ')] }));
    expect(missing.sent!.content).toBe('No job with ID ZZZZ-ZZZZ.');
  });

  it('names a multiplayer mod by the server’s name, also one the bot doesn’t know, and its discard note', async () => {
    const { run, server } = setup();
    server.players.get(PLAYER_ID)!.singleplayer_division = true;
    server.addJob({ job_id: 'HA71MP00', game: 'ets2', owner: PLAYER_ID, outcome: 'discarded', multiplayer: { kind: 'haulmp', name: 'HaulMP' } });
    server.addJob({ job_id: 'NEW2MP00', game: 'ets2', owner: PLAYER_ID, outcome: 'valid', multiplayer: { kind: 'futuremp', name: 'FutureMP' } });
    server.addJob({ job_id: 'TRK3MP00', game: 'ats', owner: PLAYER_ID, outcome: 'valid', multiplayer: { kind: 'trucklinemp' } });
    server.addJob({ job_id: 'D0D4MP00', game: 'ats', owner: PLAYER_ID, outcome: 'valid', multiplayer: { kind: 'futuremp' } });
    const field = async (id: string, name: string) =>
      (await run(commandInteraction('job', { options: [opt('id', id)] }))).sent!.embeds![0]!.fields!.find((f) => f.name === name)?.value;
    expect(await field('HA71MP00', 'Played')).toBe('HaulMP');
    expect(await field('HA71MP00', 'Notes')).toBe('• Discarded: a HaulMP job by a Singleplayer Division player.');
    expect(await field('NEW2MP00', 'Played')).toBe('FutureMP');
    expect(await field('TRK3MP00', 'Played')).toBe('TrucklineMP');
    expect(await field('D0D4MP00', 'Played')).toBeUndefined();
    expect(await field('7K2M9QXA', 'Played')).toBe('Singleplayer');
  });

  it('says fuel is not readable rather than 0 L when the readings were beyond any tank', async () => {
    const { run, server } = setup();
    server.addJob({ job_id: 'F7E1X000', game: 'ets2', owner: PLAYER_ID, outcome: 'valid', fuel_readable: false });
    const { sent } = await run(commandInteraction('job', { options: [opt('id', 'F7E1X000')] }));
    expect(sent!.embeds![0]!.fields!.find((f) => f.name === 'Fuel used')?.value).toBe('not readable');
    const normal = await run(commandInteraction('job', { options: [opt('id', '7K2M9QXA')] }));
    expect(normal.sent!.embeds![0]!.fields!.find((f) => f.name === 'Fuel used')?.value).toBe('41.2 L');
  });
});

describe('/jobs and /leaderboard', () => {
  it('pages through a player’s jobs with buttons that carry the cursor', async () => {
    const { run, server } = setup();
    for (let i = 0; i < 12; i++) {
      server.addJob({ job_id: `A${String(i).padStart(7, '0')}`, game: 'ets2', owner: PLAYER_ID, outcome: 'valid', points: 1, scored_points: 1, world_km: 1, game_km: 10 });
    }
    const first = await run(commandInteraction('jobs', { user: PLAYER_ID, options: [opt('game', 'ets2')] }));
    expect(first.sent!.embeds![0]!.description!.split('\n').filter((l) => l.startsWith('`'))).toHaveLength(10);
    const buttons = first.sent!.components![0]!.components;
    expect(buttons.map((b) => b.label)).toEqual(['Next']);
    expect(buttons[0]!.custom_id.length).toBeLessThanOrEqual(100);

    const second = await run(buttonInteraction(buttons[0]!.custom_id, { user: OTHER_ID }));
    expect(second.response.type).toBe(6);
    expect(second.sent!.embeds![0]!.description!.split('\n').filter((l) => l.startsWith('`'))).toHaveLength(4);
    expect(second.sent!.components![0]!.components.map((b) => b.label)).toEqual(['First page']);
  });

  it('rejects a tampered page button', async () => {
    const { run } = setup();
    const { response } = await run(buttonInteraction('jobs:ets2:not-an-id:-:', { user: PLAYER_ID }));
    expect(response.type).toBe(7);
  });

  it('shows the leaderboard per game, marks the reader, and validates past periods', async () => {
    const { run, server } = setup();
    const { sent } = await run(commandInteraction('leaderboard', { user: PLAYER_ID, options: [opt('game', 'ets2'), opt('period', 'month'), opt('when', '2026-10')] }));
    expect(sent!.embeds![0]!.title).toBe('Euro Truck Simulator 2');
    expect(sent!.embeds![0]!.description).toContain('**1.** KoJesko · **7** pts · 1 job · 7.07 mi (11.38 km) ← you');
    expect(server.calls.at(-1)!.path).toContain('period=month');
    expect(server.calls.at(-1)!.path).toContain('at=2026-10');

    const bad = await run(commandInteraction('leaderboard', { options: [opt('game', 'ats'), opt('when', '2026-10')] }));
    expect(bad.response.type).toBe(4);
    expect(bad.response.data!.content).toContain('`when` needs `period`');
  });
});

describe('TruckersMP lookups', () => {
  it('reads the linked Discord account and caches it for a day', async () => {
    let calls = 0;
    const clock = new FakeClock();
    const client = new TruckersMpClient({
      cache: new MemoryBlobCache(),
      clock,
      fetch: async (url, init) => {
        calls++;
        expect(String(url)).toBe('https://api.truckersmp.com/v2/player/111');
        expect(new Headers(init?.headers).get('User-Agent')).toContain('PlasmaTrack-Bot');
        return Response.json({ error: false, response: { id: 111, name: 'Driver', discordSnowflake: '123456789012345678', banned: false } });
      },
    });
    expect(await checkTruckersMpAccounts(client, '123456789012345678', [111, 111, 0])).toEqual([
      { accountId: 111, status: 'confirmed', name: 'Driver' },
    ]);
    await client.player(111);
    expect(calls).toBe(1);
    clock.t += 25 * 3600_000;
    await client.player(111);
    expect(calls).toBe(2);
  });

  it('treats TruckersMP being down as "couldn’t check", without caching it', async () => {
    let calls = 0;
    const client = new TruckersMpClient({
      cache: new MemoryBlobCache(),
      fetch: async () => {
        calls++;
        return new Response('down', { status: 503 });
      },
    });
    expect(await checkTruckersMpAccounts(client, PLAYER_ID, [5])).toEqual([{ accountId: 5, status: 'unknown' }]);
    await client.player(5);
    expect(calls).toBe(2);
  });
});
