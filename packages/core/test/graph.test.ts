import type { APIInteraction } from 'discord-api-types/v10';
import { describe, expect, it } from 'vitest';
import { PlasmaTrackApi } from '../src/api/client.ts';
import { bucketLabel, fuelIn, isoWeek } from '../src/commands/graph.ts';
import { tasks } from '../src/commands/index.ts';
import { handleInteraction } from '../src/interactions/router.ts';
import { processQueueMessage } from '../src/interactions/tasks.ts';
import type { QueueMessage } from '../src/interactions/types.ts';
import type { BarsRenderRequest, ChartRenderRequest } from '../src/render/protocol.ts';
import { commandInteraction, FakeClock, routerDeps, taskDeps } from './helpers.ts';
import { BASE_URL, BOT_TOKEN, MockPlasmaTrackServer, OTHER_ID, PLAYER_ID } from './mock-api.ts';

// /graph (owner, 2026-10-15): player history, one job's series, leaderboard comparisons.

const EPHEMERAL = 64;
type Sent = { content?: string; flags?: number; embeds?: { title?: string; description?: string; footer?: { text: string }; image?: { url: string } }[] };

let nextId = 9000;
const id = () => String(820000000000000000n + BigInt(nextId++));
const opt = (name: string, value: unknown, type = 3) => ({ name, type, value });
const sub = (name: string, options: unknown[] = []) => ({ name, type: 1, options });

function setup() {
  const server = new MockPlasmaTrackServer();
  const t = taskDeps();
  t.backend.api = new PlasmaTrackApi({ baseUrl: BASE_URL, token: BOT_TOKEN, fetch: server.fetch });
  const bars: BarsRenderRequest[] = [];
  const charts: ChartRenderRequest[] = [];
  const png = { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), contentType: 'image/png', cached: false };
  t.deps.renderer = {
    renderRoute: async () => png,
    renderChart: async (req) => (charts.push(req), png),
    renderBars: async (req) => (bars.push(req), png),
  };
  async function graph(subName: string, options: unknown[], user = PLAYER_ID) {
    const { deps, queue } = routerDeps({ clock: t.clock as FakeClock });
    const { response } = await handleInteraction(commandInteraction('graph', { user, id: id(), options: [sub(subName, options)] }) as APIInteraction, deps);
    const before = t.discord.calls.length;
    for (const m of queue.take().filter((x): x is Extract<QueueMessage, { type: 'interaction-task' }> => x.type === 'interaction-task')) {
      await processQueueMessage(m, tasks, t.deps);
    }
    const last = t.discord.calls.slice(before).filter((c) => c.op === 'edit').at(-1);
    return { response: response as { type: number; data?: Sent }, sent: last?.message as Sent | undefined, files: (last?.files ?? []) as { name: string }[] };
  }
  return { server, graph, bars, charts, ...t };
}

describe('/graph player', () => {
  it('charts distance per week both ways, publicly, with totals for the range', async () => {
    const s = setup();
    const { sent, files } = await s.graph('player', [opt('game', 'ets2'), opt('metric', 'distance')]);
    expect(sent!.flags ?? 0).toBe(0);
    expect(files.map((f) => f.name)).toEqual(['distance-game.png', 'distance-world.png']);
    expect(s.bars).toHaveLength(2);
    const [game, world] = s.bars;
    expect(game!.kind).toBe('columns');
    expect(game!.labels).toHaveLength(12);
    expect(game!.labels.at(-1)).toBe('W42'); // the week of 2026-10-12, holding job 7K2M-9QXA
    expect(game!.values.at(-1)).toBeCloseTo(125.7 / 1.609344, 1);
    expect(world!.values.at(-1)).toBeCloseTo(11.38 / 1.609344, 1);
    expect(game!.title).toContain('per week');
    const text = sent!.embeds![0]!.description!;
    expect(text).toContain('Distance in game in these 12 weeks: **78.11 mi**');
    expect(text).toContain('1 counted job in this range');
  });

  it('draws the running total as a line, fuel in litres for ETS2', async () => {
    const s = setup();
    const { sent } = await s.graph('player', [opt('game', 'ets2'), opt('metric', 'fuel'), opt('per', 'day'), opt('running_total', true, 5)]);
    expect(s.bars).toHaveLength(1);
    expect(s.bars[0]!.kind).toBe('line');
    expect(s.bars[0]!.labels).toHaveLength(30);
    expect(s.bars[0]!.values.at(-1)).toBe(41.2);
    expect(s.bars[0]!.unit).toBe('L');
    expect(sent!.embeds![0]!.description).toContain('All-time fuel used: **41.2 L**');
  });

  it('leaves periods without jobs out of the damage average instead of drawing 0 %', async () => {
    const s = setup();
    await s.graph('player', [opt('game', 'ets2'), opt('metric', 'damage')]);
    const values = s.bars[0]!.values;
    expect(values.at(-1)).toBe(1.5);
    expect(values.slice(0, -1).every((v) => v === null)).toBe(true);
  });

  it('charts income in the game’s currency, and says when a player isn’t linked', async () => {
    const s = setup();
    await s.graph('player', [opt('game', 'ets2'), opt('metric', 'income'), opt('per', 'month')]);
    expect(s.bars[0]!.unit).toBe('€');
    expect(s.bars[0]!.labels.at(-1)).toBe('Oct 2026');
    expect(s.bars[0]!.values.at(-1)).toBe(4210);

    const unlinked = await s.graph('player', [opt('game', 'ets2'), opt('metric', 'income'), opt('user', '333333333333333333', 6)]);
    expect(unlinked.sent!.content).toBe('That player hasn’t linked PlasmaTrack.');
  });
});

describe('/graph job', () => {
  it('shows speed, fuel, distance both ways and damage for an approved or valid job, without reverted parts', async () => {
    const s = setup();
    const { sent, files } = await s.graph('job', [opt('id', '7k2m-9qxa')], OTHER_ID);
    expect(files.map((f) => f.name)).toEqual(['speed.png', 'fuel.png', 'distance-game.png', 'distance-world.png', 'damage.png']);
    expect(sent!.embeds![0]!.title).toBe('Job 7K2M-9QXA · Euro Truck Simulator 2 · Valid');
    // The public series has no reverted window and no review markers.
    expect(s.charts.flatMap((c) => c.bands ?? []).map((b) => b.kind)).not.toContain('reverted');
    expect(s.charts.every((c) => (c.markers ?? []).length === 0)).toBe(true);
    expect(s.server.calls.some((c) => c.path.includes('/admin/'))).toBe(false);
  });

  it('can show one chart only', async () => {
    const s = setup();
    const { files } = await s.graph('job', [opt('id', '7K2M9QXA'), opt('chart', 'distance')]);
    expect(files.map((f) => f.name)).toEqual(['distance-game.png', 'distance-world.png']);
  });

  it('keeps jobs in review, rejected or invalid for moderators, and has nothing for manual jobs', async () => {
    const s = setup();
    const pending = await s.graph('job', [opt('id', 'R3VW5T6Y')]);
    expect(pending.sent!.content).toContain('Its graphs are public once it’s valid or approved');
    expect(pending.sent!.content).toContain('/review job');
    const invalid = await s.graph('job', [opt('id', 'H8JK2MNP')]);
    expect(invalid.sent!.content).toContain('is invalid');
    expect(s.charts).toHaveLength(0);
  });
});

describe('/graph leaderboard', () => {
  it('compares the top players as rows, with value labels in the game’s units', async () => {
    const s = setup();
    const { sent } = await s.graph('leaderboard', [opt('game', 'ets2'), opt('metric', 'income')]);
    expect(s.bars).toHaveLength(1);
    expect(s.bars[0]!.kind).toBe('rows');
    expect(s.bars[0]!.value_labels).toEqual(['€4,210']);
    expect(sent!.embeds![0]!.title).toBe('Euro Truck Simulator 2 · top 15 by income');
    expect(s.server.calls.find((c) => c.path.includes('/leaderboard'))!.path).toContain('sort=income');
  });

  it('ranks distance both ways, and damage least first', async () => {
    const s = setup();
    await s.graph('leaderboard', [opt('game', 'ets2'), opt('metric', 'distance')]);
    const sorts = s.server.calls.filter((c) => c.path.includes('/leaderboard')).map((c) => new URL(c.path, BASE_URL).searchParams.get('sort'));
    expect(sorts).toEqual(['game_distance', 'distance']);
    expect(s.bars.map((b) => b.unit)).toEqual(['mi', 'mi']);

    const d = setup();
    const { sent } = await d.graph('leaderboard', [opt('game', 'ets2'), opt('metric', 'damage')]);
    expect(sent!.embeds![0]!.title).toContain('least cargo damage');
    expect(d.bars[0]!.value_labels).toEqual(['1.5 %']);
  });

  it('checks `when` against the period before asking the server', async () => {
    const s = setup();
    const { response } = await s.graph('leaderboard', [opt('game', 'ets2'), opt('metric', 'fuel'), opt('when', '2026-W42')]);
    expect(response.data!.content).toContain('`when` needs `period`');
    expect(response.data!.flags! & EPHEMERAL).toBeTruthy();
  });
});

describe('graph helpers', () => {
  it('labels buckets and converts fuel', () => {
    expect(isoWeek(new Date('2026-01-01T00:00:00Z'))).toBe(1);
    expect(isoWeek(new Date('2026-12-31T00:00:00Z'))).toBe(53);
    expect(bucketLabel('2026-10-12T00:00:00.000Z', 'week')).toBe('W42');
    expect(bucketLabel('2026-10-14T00:00:00.000Z', 'day')).toBe('Oct 14');
    expect(fuelIn('ats', 37.85411784)).toBe(10);
    expect(fuelIn('ets2', 12.345)).toBe(12.35);
  });
});
