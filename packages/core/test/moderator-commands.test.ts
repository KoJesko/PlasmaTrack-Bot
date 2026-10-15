import type { APIInteraction } from 'discord-api-types/v10';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlasmaTrackApi } from '../src/api/client.ts';
import { tasks } from '../src/commands/index.ts';
import { DiscordApiError } from '../src/discord/rest.ts';
import { handleInteraction, NOT_ALLOWED } from '../src/interactions/router.ts';
import { processQueueMessage } from '../src/interactions/tasks.ts';
import type { QueueMessage } from '../src/interactions/types.ts';
import { buttonInteraction, commandInteraction, FakeClock, modalInteraction, MOD_ROLE, routerDeps, taskDeps } from './helpers.ts';
import { ADMIN_ID, BASE_URL, BOT_TOKEN, MockPlasmaTrackServer, OTHER_ID, PLAYER_ID } from './mock-api.ts';

const EPHEMERAL = 64;
type Embed = { title?: string; description?: string; fields?: { name: string; value: string }[]; image?: { url: string } };
type Sent = {
  content?: string;
  flags?: number;
  embeds?: Embed[];
  components?: { components: { custom_id?: string; label?: string; options?: { value: string }[] }[] }[];
};

afterEach(() => {
  vi.restoreAllMocks();
});

let nextId = 1000;
const id = () => String(800000000000000000n + BigInt(nextId++));
const mod = (extra: Record<string, unknown> = {}) => ({ user: ADMIN_ID, roles: [MOD_ROLE], id: id(), ...extra });
const opt = (name: string, value: unknown, type = 3) => ({ name, type, value });
const sub = (name: string, options: unknown[] = []) => ({ name, type: 1, options });
const group = (name: string, subName: string, options: unknown[] = []) => ({ name, type: 2, options: [sub(subName, options)] });

function setup() {
  const server = new MockPlasmaTrackServer();
  const t = taskDeps();
  t.backend.api = new PlasmaTrackApi({ baseUrl: BASE_URL, token: BOT_TOKEN, fetch: server.fetch });
  const renders: string[] = [];
  t.deps.renderer = {
    renderRoute: async () => {
      renders.push('route');
      return { bytes: new Uint8Array([1]), contentType: 'image/png', cached: false };
    },
    renderChart: async (req) => {
      renders.push(`chart:${req.unit}`);
      return { bytes: new Uint8Array([1]), contentType: 'image/png', cached: false };
    },
  };

  async function run(interaction: APIInteraction) {
    const { deps, queue } = routerDeps({ clock: t.clock as FakeClock });
    const { response } = await handleInteraction(interaction, deps);
    const before = t.discord.calls.length;
    for (const m of queue.take().filter((x): x is Extract<QueueMessage, { type: 'interaction-task' }> => x.type === 'interaction-task')) {
      await processQueueMessage(m, tasks, t.deps);
    }
    const edits = t.discord.calls.slice(before).filter((c) => c.op === 'edit');
    const last = edits.at(-1);
    return {
      response: response as { type: number; data?: Sent & { custom_id?: string; title?: string } },
      sent: last?.message as Sent | undefined,
      files: (last?.files ?? []) as { name: string }[],
    };
  }
  return { server, run, renders, ...t };
}

describe('moderator access', () => {
  it('members without a moderator role are refused, before any server call', async () => {
    const { run, server } = setup();
    const { response } = await run(commandInteraction('review', { user: PLAYER_ID, options: [sub('queue')] }));
    expect(response.data!.content).toBe(NOT_ALLOWED);
    expect(server.calls).toHaveLength(0);
  });

  it('the server has the final say on who is an admin', async () => {
    const { run } = setup();
    const { sent } = await run(commandInteraction('review', { ...mod(), user: OTHER_ID, options: [sub('queue')] }));
    expect(sent!.content).toContain('doesn’t list you as an admin');
  });

  it('every moderator reply is private', async () => {
    const { run } = setup();
    const { response, sent } = await run(commandInteraction('review', mod({ options: [sub('queue')] })));
    expect(response).toEqual({ type: 5, data: { flags: EPHEMERAL } });
    expect(sent!.flags).toBe(EPHEMERAL);
  });
});

describe('/review', () => {
  it('lists the queue and opens a job from the menu, with images and allowed actions only', async () => {
    const { run, renders } = setup();
    const queue = await run(commandInteraction('review', mod({ options: [sub('queue')] })));
    expect(queue.sent!.embeds![0]!.title).toBe('Review queue (2)');
    const menu = queue.sent!.components![0]!.components[0]!;
    expect(menu.custom_id).toBe('mjob-pick');
    expect(menu.options!.map((o) => o.value)).toEqual(['R3VW5T6Y', 'H8JK2MNP']);

    const view = await run(buttonInteraction('mjob-pick', mod({ values: ['R3VW5T6Y'] })));
    expect(view.response).toEqual({ type: 5, data: { flags: EPHEMERAL } });
    const [main] = view.sent!.embeds!;
    expect(main!.title).toBe('Job R3VW-5T6Y · ETS2 · In review');
    expect(view.files.map((f) => f.name)).toEqual(['route.png', 'speed.png', 'fuel.png']);
    expect(renders.sort()).toEqual(['chart:L', 'chart:mph', 'route']);
    const labels = view.sent!.components!.flatMap((r) => r.components.map((c) => c.label));
    expect(labels).toEqual(['Approve', 'Reject', 'Void', 'Recalculate', 'Trace', 'Refresh']);
  });

  it('approves through the reason form, with the etag and an audit entry', async () => {
    const { run, server } = setup();
    const view = await run(commandInteraction('review', mod({ options: [sub('job', [opt('id', 'r3vw-5t6y')])] })));
    const approveId = view.sent!.components![0]!.components[0]!.custom_id!;
    expect(approveId).toMatch(/^mdec:approve:R3VW5T6Y:"jR3VW5T6Y-v\d+"$/);

    const form = await run(buttonInteraction(approveId, mod()));
    expect(form.response.type).toBe(9);
    expect(form.response.data!.custom_id).toBe(approveId);

    const done = await run(modalInteraction(approveId, mod({ fields: { reason: 'Route checked; late start explained.' } })));
    expect(done.sent!.content).toBe('Approved job R3VW-5T6Y. It is now **Approved**. Points: **90.3**.');
    expect(server.jobs.get('R3VW5T6Y')!.outcome).toBe('approved');
    expect(server.audit.at(-1)).toMatchObject({ action: 'job.approve', reason: 'Route checked; late start explained.', actor: { discord_user_id: ADMIN_ID } });
  });

  it('a decision from a stale view is refused, not applied', async () => {
    const { run, server } = setup();
    const view = await run(commandInteraction('review', mod({ options: [sub('job', [opt('id', 'R3VW5T6Y')])] })));
    const approveId = view.sent!.components![0]!.components[0]!.custom_id!;
    server.jobs.get('R3VW5T6Y')!.version++; // another moderator acted meanwhile
    const done = await run(modalInteraction(approveId, mod({ fields: { reason: 'Looks fine to me' } })));
    expect(done.sent!.content).toContain('Another moderator changed job R3VW-5T6Y');
    expect(server.jobs.get('R3VW5T6Y')!.outcome).toBe('pending_review');
  });

  it('a voided job only offers Restore', async () => {
    const { run, server } = setup();
    server.addJob({ job_id: 'V01DED00', game: 'ats', owner: PLAYER_ID, outcome: 'voided', before_void: 'valid' });
    const view = await run(commandInteraction('review', mod({ options: [sub('job', [opt('id', 'V01DED00')])] })));
    expect(view.sent!.components![0]!.components.map((c) => c.label)).toEqual(['Restore']);
  });

  it('recalculates one job from its button', async () => {
    const { run } = setup();
    const form = await run(buttonInteraction('mrec:R3VW5T6Y', mod()));
    expect(form.response.type).toBe(9);
    const done = await run(modalInteraction('mrec:R3VW5T6Y', mod({ fields: { reason: 'New config published' } })));
    expect(done.sent!.content).toContain('Recalculated job R3VW-5T6Y: unchanged');
  });

  it('attaches a small trace, and links a large one', async () => {
    const { run, server } = setup();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Uint8Array([0x1f, 0x8b, 1, 2])));
    const small = await run(commandInteraction('review', mod({ options: [sub('trace', [opt('id', 'R3VW5T6Y')])] })));
    expect(small.files.map((f) => f.name)).toEqual(['trace-R3VW-5T6Y.jsonl.gz']);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(server.audit.at(-1)).toMatchObject({ action: 'trace.download' });

    // Over 10 MiB: a private link instead.
    const orig = server.fetch;
    (server as unknown as { fetch: typeof fetch }).fetch = async (input, init) => {
      const res = await orig(input, init);
      if (!String(input).endsWith('/trace')) return res;
      const json = (await res.json()) as Record<string, unknown>;
      return Response.json({ ...json, size_bytes: 50 * 1024 * 1024 });
    };
    const t2 = setup();
    t2.backend.api = new PlasmaTrackApi({ baseUrl: BASE_URL, token: BOT_TOKEN, fetch: server.fetch });
    const big = await t2.run(commandInteraction('review', mod({ options: [sub('trace', [opt('id', 'R3VW5T6Y')])] })));
    expect(big.files).toEqual([]);
    expect(big.sent!.content).toContain('only you can see this');
    expect(big.sent!.content).toContain('/dl/trace/R3VW5T6Y');
  });
});

describe('/recalc all', () => {
  it('shows the count first, then starts after a confirm and a reason; one at a time', async () => {
    const { run, server } = setup();
    const dry = await run(commandInteraction('recalc', mod({ options: [sub('all', [opt('game', 'ets2')])] })));
    expect(dry.sent!.content).toContain('re-score **2** jobs in ETS2');
    expect(server.operations.size).toBe(0);
    const confirm = dry.sent!.components![0]!.components[0]!.custom_id!;
    expect(confirm).toBe('mrall:ets2');
    expect((await run(buttonInteraction(confirm, mod()))).response.type).toBe(9);
    const started = await run(modalInteraction(confirm, mod({ fields: { reason: 'Medical bonus added' } })));
    expect(started.sent!.content).toMatch(/Started: re-scoring 2 jobs in ETS2 \(operation `op_\d+`\)/);
    const again = await run(modalInteraction(confirm, mod({ fields: { reason: 'Again please' } })));
    expect(again.sent!.content).toContain('already running');
  });
});

describe('/bonus', () => {
  it('creates, lists and archives; rejects bad input before calling the server', async () => {
    const { run, server } = setup();
    const create = (extra: unknown[] = []) =>
      commandInteraction(
        'bonus',
        mod({
          options: [
            sub('create', [
              opt('game', 'ets2'),
              opt('label', 'Medical week'),
              opt('cargo', 'MED_*'),
              opt('kind', 'multiplier'),
              opt('amount', 1.5, 10),
              opt('from', '2026-10-19'),
              opt('to', '2026-10-26 00:00'),
              opt('reason', 'October event'),
              ...extra,
            ]),
          ],
        }),
      );
    const made = await run(create());
    expect(made.sent!.content).toContain('Created:');
    const bonus = [...server.bonuses.values()][0]!;
    expect(bonus).toMatchObject({ match: 'med_*', match_kind: 'glob', amount: 1.5, active_from: '2026-10-19T00:00:00.000Z', active_to: '2026-10-26T00:00:00.000Z' });

    const listed = await run(commandInteraction('bonus', mod({ options: [sub('list', [opt('status', 'scheduled')])] })));
    expect(listed.sent!.embeds![0]!.description).toContain('Medical week');

    const archived = await run(commandInteraction('bonus', mod({ options: [sub('archive', [opt('id', bonus['bonus_id']), opt('reason', 'Event cancelled')])] })));
    expect(archived.sent!.content).toContain('Archived');

    const calls = server.calls.length;
    const bad = await run(
      commandInteraction('bonus', mod({ options: [sub('create', [opt('game', 'ets2'), opt('label', 'x'), opt('cargo', 'a'), opt('kind', 'multiplier'), opt('amount', 1.5, 10), opt('from', '19/10/2026'), opt('to', '2026-10-26'), opt('reason', 'xyz')])] })),
    );
    expect(bad.response.data!.content).toContain('Dates are UTC');
    expect(server.calls.length).toBe(calls);
  });
});

describe('/player', () => {
  it('a moderator-issued token is sent to the player as a button; the moderator never sees it', async () => {
    const { run, discord, grants, server, lines, queue } = setup();
    const issued = await run(commandInteraction('player', mod({ options: [group('token', 'issue', [opt('user', OTHER_ID, 6), opt('reason', 'Asked in #support')])] })));
    expect(issued.sent!.content).toContain('Sent <@234567890123456789> a button');
    expect(JSON.stringify(issued.sent)).not.toMatch(/pt_live_/);
    expect(server.calls.filter((c) => c.method === 'POST')).toHaveLength(0); // nothing issued yet

    const dm = discord.calls.find((c) => c.op === 'dm')!;
    expect(dm.target).toBe(OTHER_ID);
    const button = (dm.message as Sent).components![0]!.components[0]!.custom_id!;
    expect(button).toMatch(/^tokg:[0-9a-f-]{36}$/);

    // Someone else can't collect it.
    const wrong = await run(buttonInteraction(button, { guild: false, user: PLAYER_ID, id: id() }));
    expect(wrong.sent!.content).toBe('This button isn’t for you.');

    // The player clicks in their DM: the token is created now, by the moderator, and shown only to them.
    const got = await run(buttonInteraction(button, { guild: false, user: OTHER_ID, id: id() }));
    expect(got.sent!.flags).toBe(EPHEMERAL);
    expect(got.sent!.content).toMatch(/pt_live_mock_tok_\d+_plaintext/);
    // Never logged or queued.
    const token = /pt_live_mock_tok_\d+_plaintext/.exec(got.sent!.content!)![0];
    expect(lines.some((l) => l.line.includes(token))).toBe(false);
    expect(JSON.stringify(queue.items)).not.toContain(token);
    expect(server.audit.at(-1)).toMatchObject({ action: 'token.issue', actor: { discord_user_id: ADMIN_ID }, reason: 'Asked in #support' });
    expect([...grants.grants.values()][0]!.usedAt).not.toBeNull();

    const again = await run(buttonInteraction(button, { guild: false, user: OTHER_ID, id: id() }));
    expect(again.sent!.content).toContain('already collected');
  });

  it('with DMs closed, the button waits in the player’s /notices', async () => {
    const { run, discord } = setup();
    discord.dmFailures.set(OTHER_ID, new DiscordApiError(403, 50007, undefined, 'Cannot send messages to this user'));
    const issued = await run(commandInteraction('player', mod({ options: [group('token', 'issue', [opt('user', OTHER_ID, 6), opt('reason', 'Asked in #support')])] })));
    expect(issued.sent!.content).toContain('DMs are closed');
    const notices = await run(commandInteraction('notices', { user: OTHER_ID, id: id() }));
    expect(notices.sent!.components![0]!.components[0]!.custom_id).toMatch(/^tokg:/);
    expect(JSON.stringify(notices.sent)).toContain('issued you a PlasmaTrack token');
  });

  it('sets the Singleplayer Division and blocks uploads, with the reason', async () => {
    const { run, server } = setup();
    const div = await run(commandInteraction('player', mod({ options: [sub('division', [opt('user', PLAYER_ID, 6), opt('singleplayer', true, 5), opt('reason', 'Asked to join')])] })));
    expect(div.sent!.content).toContain('is now in the Singleplayer Division');
    expect(server.players.get(PLAYER_ID)!.singleplayer_division).toBe(true);
    const off = await run(commandInteraction('player', mod({ options: [sub('access', [opt('user', PLAYER_ID, 6), opt('disabled', true, 5), opt('reason', 'Cheating')])] })));
    expect(off.sent!.content).toContain('can no longer upload');
    expect(server.audit.filter((a) => a['action'] === 'player.update').map((a) => a['reason'])).toEqual(['Asked to join', 'Cheating']);
  });

  it('shows a player with TruckersMP confirmation', async () => {
    const { run, server, deps } = setup();
    server.truckersmpAccounts.set(PLAYER_ID, [111]);
    deps.truckersmp = { player: async () => ({ accountId: 111, name: 'Driver', discordId: PLAYER_ID, banned: false }) };
    const shown = await run(commandInteraction('player', mod({ options: [sub('show', [opt('user', PLAYER_ID, 6)])] })));
    expect(JSON.stringify(shown.sent)).toContain('✓ confirmed by TruckersMP');
  });
});

describe('/config, /admins, /audit', () => {
  it('publishes an uploaded plasmatrack.toml', async () => {
    const { run, server } = setup();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('[scoring]\ntolerance = 3\n'));
    const file = { url: 'https://cdn.discordapp.com/attachments/1/2/plasmatrack.toml', size: 24, filename: 'plasmatrack.toml' };
    const res = await run(
      commandInteraction('config', mod({ attachments: { a1: file }, options: [sub('publish', [opt('file', 'a1', 11), opt('current', true, 5), opt('reason', 'Tolerance change')])] })),
    );
    expect(res.sent!.content).toContain('Published `cfg_1` and made it current');
    expect(server.configVersions).toHaveLength(1);
  });

  it('adds an admin and shows the audit log', async () => {
    const { run } = setup();
    const add = await run(commandInteraction('admins', mod({ options: [sub('add', [opt('user', OTHER_ID, 6), opt('reason', 'New moderator')])] })));
    expect(add.sent!.content).toContain('is now an admin');
    await run(commandInteraction('player', mod({ options: [sub('division', [opt('user', PLAYER_ID, 6), opt('singleplayer', true, 5), opt('reason', 'Asked to join')])] })));
    const audit = await run(commandInteraction('audit', mod({ options: [opt('user', PLAYER_ID, 6)] })));
    expect(audit.sent!.embeds![0]!.description).toContain('`player.update`');
  });
});

describe('review channel posts', () => {
  const event = (type: string, version: number, data: Record<string, unknown>, eventId = `evt_${type}_${version}`): QueueMessage => ({
    type: 'webhook',
    backend: 'production',
    chunk: 0,
    event: {
      event_id: eventId,
      type,
      occurred_at: '2026-10-14T09:20:11.204Z',
      payload_version: 1,
      data: {
        job_id: '7K2M9QXA',
        game: 'ets2',
        job_version: version,
        player: { user_id: 'usr_1', discord_user_id: PLAYER_ID, display_name: 'KoJesko' },
        ...data,
      },
    },
  });

  it('posts a job that needs review, then edits it with the decision; stale events are ignored', async () => {
    const t = taskDeps();
    t.reviewChannels.push('900000000000000001');
    await processQueueMessage(event('job.needs_review', 3, { outcome: 'pending_review', held_points: 90.3, reasons: [{ code: 'late_start' }] }), [], t.deps);
    const post = t.discord.calls.find((c) => c.op === 'post')!;
    expect(post.target).toBe('900000000000000001');
    expect(JSON.stringify(post.message)).toContain('mjob:7K2M9QXA');
    expect(JSON.stringify(post.message)).toContain('late_start');

    await processQueueMessage(event('job.scored', 5, { outcome: 'approved', previous_outcome: 'pending_review', points: 90.3, held_points: null, by: { kind: 'moderator', discord_user_id: ADMIN_ID } }), [], t.deps);
    const edit = t.discord.calls.find((c) => c.op === 'edit-post')!;
    expect(edit.target).toBe('900000000000000001/msg1');
    expect(JSON.stringify(edit.message)).toContain(`Approved** · 90.3 points by <@${ADMIN_ID}>`);

    // Older than what was handled: nothing changes.
    await processQueueMessage(event('job.needs_review', 4, { outcome: 'pending_review', reasons: [] }), [], t.deps);
    expect(t.discord.calls.filter((c) => c.op === 'post' || c.op === 'edit-post')).toHaveLength(2);
  });

  it('a scored job that never needed review posts nothing; a failed post is retried, not skipped', async () => {
    const t = taskDeps();
    t.reviewChannels.push('900000000000000001');
    await processQueueMessage(event('job.scored', 1, { outcome: 'valid', points: 7, by: { kind: 'rules' } }), [], t.deps);
    expect(t.discord.calls).toHaveLength(0);

    t.discord.failNext = new DiscordApiError(503, undefined, 2, 'unavailable');
    const msg = event('job.needs_review', 2, { outcome: 'pending_review', reasons: [] });
    expect(await processQueueMessage(msg, [], t.deps)).toEqual({ status: 'retry', delaySeconds: 2 });
    expect(await processQueueMessage(msg, [], t.deps)).toEqual({ status: 'done' });
    expect(t.discord.calls.filter((c) => c.op === 'post')).toHaveLength(1);
  });

  it('announces a finished recalculation', async () => {
    const t = taskDeps();
    t.reviewChannels.push('900000000000000001');
    const msg: QueueMessage = {
      type: 'webhook',
      backend: 'production',
      chunk: 0,
      event: {
        event_id: 'evt_op',
        type: 'operation.completed',
        occurred_at: '2026-10-14T09:20:11.204Z',
        payload_version: 1,
        data: { operation_id: 'op_9xk2', kind: 'recalculation', status: 'succeeded', summary: { jobs: 1243, changed: { 'pending_review→valid': 3 } }, requested_by: { discord_user_id: ADMIN_ID } },
      },
    };
    await processQueueMessage(msg, [], t.deps);
    expect((t.discord.calls[0]!.message as { content: string }).content).toContain('has **succeeded**. 1243 jobs.');
  });
});

describe('demo backend', () => {
  it('treats any moderator the bot let through as an admin, with made-up data only', async () => {
    const { demoApi } = await import('../src/demo/index.ts');
    const queue = await demoApi().admin('555555555555555555').reviewQueueCount();
    expect(queue.pending_review).toBeGreaterThan(0);
  });
});
