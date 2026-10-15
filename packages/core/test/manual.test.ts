import type { APIInteraction } from 'discord-api-types/v10';
import { describe, expect, it } from 'vitest';
import { PlasmaTrackApi } from '../src/api/client.ts';
import { tasks } from '../src/commands/index.ts';
import { DRAFT_TTL_MS } from '../src/commands/submit.ts';
import { handleInteraction } from '../src/interactions/router.ts';
import { processQueueMessage } from '../src/interactions/tasks.ts';
import { RetryableError, type QueueMessage } from '../src/interactions/types.ts';
import { MediaError, type MediaFetcher } from '../src/media.ts';
import { buttonInteraction, commandInteraction, FakeClock, fakePng, MOD_ROLE, routerDeps, taskDeps } from './helpers.ts';
import { ADMIN_ID, BASE_URL, BOT_TOKEN, MockPlasmaTrackServer, OTHER_ID, PLAYER_ID } from './mock-api.ts';

// /submit, the moderator commands for manual jobs and edits, /stats and /history.

const EPHEMERAL = 64;
type Embed = { title?: string; description?: string; fields?: { name: string; value: string }[]; image?: { url: string }; footer?: { text: string } };
type Sent = { content?: string; flags?: number; embeds?: Embed[]; components?: { components: { custom_id?: string; label?: string }[] }[] };

let nextId = 5000;
const id = () => String(810000000000000000n + BigInt(nextId++));
const opt = (name: string, value: unknown, type = 3) => ({ name, type, value });
const sub = (name: string, options: unknown[] = []) => ({ name, type: 1, options });
const mod = (extra: Record<string, unknown> = {}) => ({ user: ADMIN_ID, roles: [MOD_ROLE], id: id(), ...extra });

const CDN = 'https://cdn.discordapp.com/attachments/1/2';

function setup() {
  const server = new MockPlasmaTrackServer();
  const t = taskDeps();
  t.backend.api = new PlasmaTrackApi({ baseUrl: BASE_URL, token: BOT_TOKEN, fetch: server.fetch });
  // Discord attachments come from the test's file map; evidence links from the mock server.
  const local = t.deps.media;
  const media: MediaFetcher = {
    async get(url, max) {
      if (url.startsWith(BASE_URL)) {
        const res = await server.fetch(url);
        if (!res.ok) throw new MediaError(String(res.status));
        return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get('Content-Type') ?? '' };
      }
      return local.get(url, max);
    },
  };
  t.deps.media = media;

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
      response: response as { type: number; data?: Sent },
      sent: last?.message as Sent | undefined,
      files: (last?.files ?? []) as { name: string; bytes: Uint8Array; contentType: string }[],
    };
  }

  /** An attachment the player "uploaded" to Discord. */
  function attach(name: string, bytes = fakePng(2048), contentType = 'image/png') {
    const url = `${CDN}/${name}`;
    t.files.set(url, { bytes, contentType });
    return { url, size: bytes.length, filename: name, content_type: contentType };
  }
  return { server, run, attach, ...t };
}

/** A valid ETS2 submission; `extra` adds or replaces options. */
function submitJob(s: ReturnType<typeof setup>, extra: { name: string; type: number; value: unknown }[] = [], attachments: Record<string, ReturnType<ReturnType<typeof setup>['attach']>> = {}) {
  const base = [
    opt('game', 'ets2'),
    opt('unit', 'km'),
    opt('fuel_unit', 'l'),
    opt('start', 'Calais'),
    opt('start_company', 'Tradeaux'),
    opt('end', 'London'),
    opt('end_company', 'Posped'),
    opt('cargo_name', 'Apples'),
    opt('distance', 380, 10),
    opt('fuel_used', 120.5, 10),
    opt('damage', 2, 10),
    opt('profit', 15000, 10),
    opt('date_started', '2026-09-27T07:00:00Z'),
    opt('date_ended', '2026-09-27 08:20'),
    opt('truck', 'Scania'),
    opt('truck_model', 'S 730'),
    opt('evidence', 'a1', 11),
  ];
  const names = new Set(extra.map((o) => o.name));
  const options = [...base.filter((o) => !names.has(o.name)), ...extra];
  const all = { a1: s.attach('proof.png'), ...attachments };
  return commandInteraction('submit', { user: PLAYER_ID, id: id(), options: [sub('job', options)], attachments: all });
}

const buttons = (m: Sent | undefined) => (m?.components ?? []).flatMap((r) => r.components).map((c) => c.custom_id!);

describe('/submit job: checks before anything is uploaded', () => {
  it('lists every problem at once, privately', async () => {
    const s = setup();
    const { response, sent } = await s.run(
      submitJob(s, [opt('date_started', 'yesterday'), opt('date_ended', '2026-09-27T08:20:00+02:00'), opt('damage', 150, 10), opt('uk_distance', 50, 10)]),
    );
    expect(response.type).toBe(4);
    expect(response.data!.flags! & EPHEMERAL).toBeTruthy();
    const text = response.data!.content!;
    expect(text).toContain('`date_started` must be a UTC time');
    expect(text).toContain('`date_ended` must be a UTC time');
    expect(text).toContain('`damage` is a percentage');
    expect(text).toContain('give all four');
    expect(sent).toBeUndefined();
    expect(s.server.calls).toHaveLength(0);
  });

  it('refuses UK fields in ATS, a non-image attachment, and an end before the start', async () => {
    const s = setup();
    const doc = s.attach('notes.pdf', new Uint8Array(100), 'application/pdf');
    const { response } = await s.run(
      submitJob(s, [opt('game', 'ats'), opt('uk_entry_city', 'Dover'), opt('date_ended', '2026-09-27T06:00:00Z'), opt('custom_map', 'd1', 11)], { d1: doc }),
    );
    const text = response.data!.content!;
    expect(text).toContain('The UK fields are for ETS2 only');
    expect(text).toContain('`custom_map` must be a PNG, JPEG or WebP image');
    expect(text).toContain('`date_ended` must be after `date_started`');
  });

  it('refuses a delivery in the future (checked against the clock when it runs)', async () => {
    const s = setup();
    const { sent } = await s.run(submitJob(s, [opt('date_ended', '2026-09-29T08:00:00Z')]));
    expect(sent!.content).toContain('in the future');
    expect(s.server.evidence.size).toBe(0);
  });
});

describe('/submit flow', () => {
  it('compresses and uploads the images, previews privately, adds the adjusted section, then sends once', async () => {
    const s = setup();
    const uk = s.attach('gps.jpg', fakePng(4096), 'image/png');
    const map = s.attach('map.png');
    const first = await s.run(
      submitJob(
        s,
        [opt('uk_distance', 76, 10), opt('uk_entry_city', 'Folkestone'), opt('uk_end_city', 'London'), opt('uk_route_evidence', 'u1', 11), opt('custom_map', 'm1', 11), opt('mod_names', 'Map A,  Trucks B ,')],
        { u1: uk, m1: map },
      ),
    );
    expect(first.response.type).toBe(5); // deferred, private
    expect(s.images.calls).toBe(3);
    expect(s.server.evidence.size).toBe(3);
    // The renderer's WebP was uploaded, not the original PNG.
    expect([...s.server.evidence.values()].every((e) => e.content_type === 'image/webp')).toBe(true);

    const preview = first.sent!;
    expect(preview.flags! & EPHEMERAL).toBeTruthy();
    const summary = preview.embeds![0]!;
    expect(summary.title).toBe('Manual submission · ETS2 (preview)');
    const field = (n: string) => summary.fields!.find((f) => f.name.startsWith(n))?.value;
    expect(field('Distance')).toBe('236.12 mi (380 km)');
    expect(field('Map scale')).toBe('1:19 (default)');
    expect(field('UK stretch')).toBe('47.22 mi (76 km): Folkestone → London');
    expect(field('Fuel')).toBe('120.5 L');
    expect(field('Profit')).toBe('€15,000');
    expect(field('Mods')).toBe('Map A, Trucks B');
    expect(preview.embeds!.slice(1).map((e) => e.title)).toEqual(['Evidence', 'Custom map', 'UK route']);
    expect(first.files.map((f) => f.name)).toEqual(['main.webp', 'custom_map.webp', 'uk_route.webp']);
    const [send1, cancel] = buttons(preview);
    expect(send1).toMatch(/^msub:send:[0-9a-f-]{36}:1$/);
    expect(cancel).toMatch(/^msub:cancel:/);
    expect(s.server.jobs.size).toBe(4); // nothing submitted yet

    // Add a section at another scale: a new preview (rev 2).
    const adj = s.attach('adj.png');
    const second = await s.run(
      commandInteraction('submit', {
        user: PLAYER_ID,
        id: id(),
        options: [sub('adjusted-scale', [opt('entry_city', 'Calais'), opt('exit_city', 'Dunkerque'), opt('distance', 40, 10), opt('scale', 1, 10), opt('evidence', 'x1', 11)])],
        attachments: { x1: adj },
      }),
    );
    expect(second.sent!.embeds![0]!.fields!.find((f) => f.name.startsWith('Adjusted'))!.value).toBe('24.85 mi (40 km): Calais → Dunkerque');
    const send2 = buttons(second.sent)[0]!;
    expect(send2).toMatch(/:2$/);

    // The older preview can no longer send.
    const stale = await s.run(buttonInteraction(send1!, { user: PLAYER_ID, id: id() }));
    expect(stale.sent!.content).toContain('out of date');
    expect(s.server.jobs.size).toBe(4);

    const sent = await s.run(buttonInteraction(send2, { user: PLAYER_ID, id: id() }));
    expect(sent.sent!.content).toMatch(/^Sent! Job \*\*MAN0-\d{4}\*\* is waiting for a moderator\. It holds \*\*\d+\*\* points/);
    expect(sent.sent!.components).toEqual([]);
    const job = [...s.server.jobs.values()].find((j) => j.origin === 'manual')!;
    expect(job.outcome).toBe('pending_review');
    expect(job.submission).toMatchObject({ unit: 'km', uk: { distance: 76 }, adjusted_scale: { distance: 40, scale: 1 }, mod_names: ['Map A', 'Trucks B'] });
    expect(job.evidence!.map((e) => e.role).sort()).toEqual(['adjusted_scale', 'custom_map', 'main', 'uk_route']);
    expect(s.drafts.drafts.size).toBe(0);

    // A second click submits nothing more.
    const again = await s.run(buttonInteraction(send2, { user: PLAYER_ID, id: id() }));
    expect(again.sent!.content).toContain('already sent');
    expect([...s.server.jobs.values()].filter((j) => j.origin === 'manual')).toHaveLength(1);
  });

  it('uploads the original when the renderer is down, if it is within 5 MB', async () => {
    const s = setup();
    s.images.fail = new RetryableError('renderer unreachable', 10);
    const { sent } = await s.run(submitJob(s));
    expect(buttons(sent)[0]).toMatch(/^msub:send:/);
    expect([...s.server.evidence.values()][0]!.content_type).toBe('image/png');
    expect(s.lines.some((l) => l.line.includes('image compression unavailable'))).toBe(true);

    const big = setup();
    big.images.fail = new RetryableError('renderer unreachable', 10);
    const { sent: tooBig } = await big.run(submitJob(big, [], { a1: big.attach('huge.png', fakePng(6 * 1024 * 1024)) }));
    expect(tooBig!.content).toContain('larger than 5 MB');
    expect(big.server.evidence.size).toBe(0);
  });

  it('cancel deletes the draft; adjusted-scale needs a draft; drafts expire after an hour', async () => {
    const s = setup();
    const { sent } = await s.run(submitJob(s));
    const cancel = buttons(sent)[1]!;
    const cancelled = await s.run(buttonInteraction(cancel, { user: PLAYER_ID, id: id() }));
    expect(cancelled.sent!.content).toBe('Cancelled. Nothing was submitted.');

    const lonely = await s.run(
      commandInteraction('submit', {
        user: PLAYER_ID,
        id: id(),
        options: [sub('adjusted-scale', [opt('entry_city', 'A'), opt('exit_city', 'B'), opt('distance', 4, 10), opt('scale', 1, 10), opt('evidence', 'x1', 11)])],
        attachments: { x1: s.attach('adj.png') },
      }),
    );
    expect(lonely.sent!.content).toContain('no submission in progress');

    const again = await s.run(submitJob(s));
    (s.clock as FakeClock).t += DRAFT_TTL_MS + 1;
    const late = await s.run(buttonInteraction(buttons(again.sent)[0]!, { user: PLAYER_ID, id: id() }));
    expect(late.sent!.content).toContain('expired');
  });
});

describe('manual jobs in /job and the evidence button', () => {
  async function submitted(s: ReturnType<typeof setup>) {
    const { sent } = await s.run(submitJob(s, [opt('custom_map', 'm1', 11)], { m1: s.attach('map.png') }));
    await s.run(buttonInteraction(buttons(sent)[0]!, { user: PLAYER_ID, id: id() }));
    return [...s.server.jobs.values()].find((j) => j.origin === 'manual')!.job_id;
  }

  it('shows the custom map publicly, and the evidence only to the submitter', async () => {
    const s = setup();
    const jobId = await submitted(s);
    const shown = await s.run(commandInteraction('job', { user: OTHER_ID, id: id(), options: [opt('id', jobId)] }));
    const embed = shown.sent!.embeds![0]!;
    expect(embed.description).toContain('Submitted by hand');
    expect(embed.image).toEqual({ url: 'attachment://custom-map.webp' });
    expect(shown.files.map((f) => f.name)).toEqual(['custom-map.webp']);
    const evidenceButton = buttons(shown.sent)[0]!;
    expect(evidenceButton).toBe(`mev:${jobId}`);

    const other = await s.run(buttonInteraction(evidenceButton, { user: OTHER_ID, id: id() }));
    expect(other.response.type).toBe(5);
    expect(other.sent!.content).toContain('Only the player who submitted this job');

    const own = await s.run(buttonInteraction(evidenceButton, { user: PLAYER_ID, id: id() }));
    expect(own.sent!.flags! & EPHEMERAL).toBeTruthy();
    expect(own.sent!.embeds!.map((e) => e.title).sort()).toEqual(['Custom map', 'Evidence']);
    expect(own.files).toHaveLength(2);
  });

  it('/approve-manual corrects stats and hides the map in one step; the public view then has no map', async () => {
    const s = setup();
    const jobId = await submitted(s);
    const approve = await s.run(
      commandInteraction('approve-manual', {
        ...mod(),
        options: [opt('job', jobId), opt('hide_map', true, 5), opt('unit', 'km'), opt('distance', 400, 10), opt('damage', 3, 10)],
      }),
    );
    expect(approve.sent!.flags! & EPHEMERAL).toBeTruthy();
    expect(approve.sent!.content).toContain('In review → **Approved**');
    expect(approve.sent!.content).toContain('distance: 248.55 mi (400 km)');
    expect(approve.sent!.content).toContain('custom map is hidden');
    const job = s.server.jobs.get(jobId)!;
    expect(job.outcome).toBe('approved');
    expect(job.hide_map).toBe(true);
    expect(job.overrides).toMatchObject({ distance: 400, damage: 3 });
    expect(s.server.audit.map((a) => a['action'])).toEqual(expect.arrayContaining(['job.edit', 'job.approve']));
    expect(s.server.audit.find((a) => a['action'] === 'job.approve')!['reason']).toBe('Manual submission approved.');

    const shown = await s.run(commandInteraction('job', { user: OTHER_ID, id: id(), options: [opt('id', jobId)] }));
    expect(shown.sent!.embeds![0]!.image).toBeUndefined();
    expect(shown.files).toEqual([]);
  });

  it('a distance correction needs its unit; tracked jobs are refused by the manual commands', async () => {
    const s = setup();
    const noUnit = await s.run(commandInteraction('approve-manual', { ...mod(), options: [opt('job', 'R3VW5T6Y'), opt('distance', 10, 10)] }));
    expect(noUnit.response.data!.content).toContain('Give `unit` with any distance');
    const tracked = await s.run(commandInteraction('decline-manual', { ...mod(), options: [opt('job', 'R3VW5T6Y'), opt('reason', 'Not convincing')] }));
    expect(tracked.sent!.content).toContain('recorded by the tracker');
    expect(s.server.jobs.get('R3VW5T6Y')!.outcome).toBe('pending_review');
  });

  it('/decline-manual rejects with the moderator’s reason', async () => {
    const s = setup();
    const jobId = await submitted(s);
    const r = await s.run(commandInteraction('decline-manual', { ...mod(), options: [opt('job', jobId), opt('reason', 'Screenshot is from another job')] }));
    expect(r.sent!.content).toContain('In review → **Rejected**');
    expect(s.server.audit.at(-1)).toMatchObject({ action: 'job.reject', reason: 'Screenshot is from another job' });
  });

  it('/review job shows a manual job’s sheet and every image to moderators', async () => {
    const s = setup();
    const jobId = await submitted(s);
    const r = await s.run(commandInteraction('review', { ...mod(), options: [sub('job', [opt('id', jobId)])] }));
    const main = r.sent!.embeds![0]!;
    const sheet = main.fields!.find((f) => f.name.startsWith('Submitted by hand'))!;
    expect(sheet.name).toBe('Submitted by hand (typed in km, l)');
    expect(sheet.value).toContain('Distance (game): 236.12 mi (380 km)');
    expect(sheet.value).toContain('Map scale: 1:19 (default)');
    expect(main.fields!.find((f) => f.name === 'Custom map')!.value).toBe('Public in /job');
    expect(r.sent!.embeds!.slice(1).map((e) => e.title).sort()).toEqual(['Custom map', 'Evidence']);
    expect(r.files.map((f) => f.name).sort()).toEqual(['custom_map-2.webp', 'main-1.webp']);
  });
});

describe('/post-approve, /post-decline and /edit-job', () => {
  it('reverse earlier decisions on any job', async () => {
    const s = setup();
    const down = await s.run(commandInteraction('post-decline', { ...mod(), options: [opt('job', '7K2M9QXA'), opt('reason', 'Cut corners, found later')] }));
    expect(down.sent!.content).toBe('Job **7K2M-9QXA**: Valid → **Rejected**, 0 points.');
    const up = await s.run(commandInteraction('post-approve', { ...mod(), options: [opt('job', '7K2M9QXA'), opt('reason', 'Appeal accepted')] }));
    expect(up.sent!.content).toBe('Job **7K2M-9QXA**: Rejected → **Approved**, 7 points.');
  });

  it('edits stats, details and clears values, reporting the overrides', async () => {
    const s = setup();
    const stats = await s.run(
      commandInteraction('edit-job', { ...mod(), options: [sub('stats', [opt('job', '7K2M9QXA'), opt('reason', 'Odometer cut off'), opt('unit', 'mi'), opt('distance', 100, 10)])] }),
    );
    expect(stats.sent!.content).toContain('Edited job **7K2M-9QXA**: distance: 100 mi (160.93 km).');
    expect(stats.sent!.content).toMatch(/All edits on this job: .*distance: 100/);
    expect(s.server.jobs.get('7K2M9QXA')!.game_km).toBeCloseTo(160.93, 1);

    const details = await s.run(
      commandInteraction('edit-job', { ...mod(), options: [sub('details', [opt('job', '7K2M9QXA'), opt('reason', 'Typo'), opt('cargo_name', 'Medicine'), opt('mod_names', 'A, B')])] }),
    );
    expect(details.sent!.content).toContain('cargo name: Medicine; mod names: A, B');

    const clear = await s.run(commandInteraction('edit-job', { ...mod(), options: [sub('clear', [opt('job', '7K2M9QXA'), opt('reason', 'Not known'), opt('fields', 'damage, bonus')])] }));
    expect(clear.sent!.content).toContain('damage: cleared; bonus id: cleared');
    expect(s.server.audit.filter((a) => a['action'] === 'job.edit')).toHaveLength(3);
  });

  it('refuses edits with nothing to change, unknown fields to clear, or a distance without unit', async () => {
    const s = setup();
    const nothing = await s.run(commandInteraction('edit-job', { ...mod(), options: [sub('details', [opt('job', '7K2M9QXA'), opt('reason', 'Nothing')])] }));
    expect(nothing.response.data!.content).toContain('Give at least one field');
    const bad = await s.run(commandInteraction('edit-job', { ...mod(), options: [sub('clear', [opt('job', '7K2M9QXA'), opt('reason', 'x y z'), opt('fields', 'cargo_name')])] }));
    expect(bad.response.data!.content).toContain('`cargo_name` can’t be cleared');
    const noUnit = await s.run(commandInteraction('edit-job', { ...mod(), options: [sub('stats', [opt('job', '7K2M9QXA'), opt('reason', 'x y z'), opt('uk_distance', 5, 10)])] }));
    expect(noUnit.response.data!.content).toContain('Give `unit`');
    expect(s.server.audit).toHaveLength(0);
  });
});

describe('/stats and /history', () => {
  it('/stats totals both games and lists outcomes per game', async () => {
    const s = setup();
    const { sent } = await s.run(commandInteraction('stats', { user: OTHER_ID, id: id(), options: [opt('user', PLAYER_ID, 6)] }));
    const embed = sent!.embeds![0]!;
    expect(embed.title).toBe('KoJesko · PlasmaTrack stats');
    expect(embed.fields![0]).toMatchObject({ name: 'Both games' });
    expect(embed.fields![0]!.value).toContain('**7** points from 1 counted jobs');
    expect(embed.fields![1]!.name).toBe('Euro Truck Simulator 2');
    expect(embed.fields![1]!.value).toContain('Jobs: 1 valid · 1 in review');
    expect(embed.fields![2]!.value).toContain('Jobs: 1 invalid · 1 discarded');
    expect(sent!.flags).toBe(0);
  });

  it('/history pages through both games, and filters by outcome', async () => {
    const s = setup();
    for (let n = 0; n < 12; n++) {
      s.server.addJob({ job_id: `B${String(n).padStart(7, '0')}`, game: n % 2 ? 'ats' : 'ets2', owner: PLAYER_ID, outcome: 'valid', points: 1, scored_points: 1, delivered_at: `2026-10-0${1 + (n % 9)}T00:00:00.000Z` });
    }
    const first = await s.run(commandInteraction('history', { id: id(), options: [opt('user', PLAYER_ID, 6)] }));
    const lines = first.sent!.embeds![0]!.description!.split('\n').filter((l) => l.includes('`'));
    expect(lines).toHaveLength(10);
    expect(lines.some((l) => l.startsWith('ATS'))).toBe(true);
    expect(lines.some((l) => l.startsWith('ETS2'))).toBe(true);
    expect(first.sent!.embeds![0]!.footer!.text).toContain('16 jobs');
    const next = buttons(first.sent).find((b) => b.length > 0)!;
    expect(next).toMatch(/^hist:\d+:-:-:.+/);
    expect(next.length).toBeLessThanOrEqual(100);
    const second = await s.run(buttonInteraction(next, { id: id() }));
    expect(second.sent!.embeds![0]!.description!.split('\n').filter((l) => l.includes('`'))).toHaveLength(6);

    const review = await s.run(commandInteraction('history', { id: id(), options: [opt('user', PLAYER_ID, 6), opt('outcome', 'pending_review'), opt('private', true, 5)] }));
    expect(review.response.type).toBe(5);
    expect(review.sent!.embeds![0]!.title).toBe('Job history (in review)');
    expect(review.sent!.embeds![0]!.description).toContain('R3VW-5T6Y');
    expect(review.sent!.flags! & EPHEMERAL).toBeTruthy();
  });
});
