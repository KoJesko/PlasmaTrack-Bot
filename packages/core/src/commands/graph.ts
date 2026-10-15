import type { APIApplicationCommandStringOption, APIEmbed } from 'discord-api-types/v10';
import { ApiError } from '../api/client.ts';
import { apiFailure, requireApi } from '../api/errors.ts';
import { formatJobId, parseJobId } from '../api/ids.ts';
import type { Division, Game, HistoryBucket, HistoryTotals, LeaderboardPeriod, LeaderboardSort, PlayerHistory } from '../api/schemas.ts';
import { ApplicationCommandOptionType, MessageFlags } from '../discord/constants.ts';
import type { OutgoingFile } from '../discord/rest.ts';
import { UserFacingError, type CommandDefinition, type TaskDefinition, type TaskDeps } from '../interactions/types.ts';
import type { BarsRenderRequest } from '../render/protocol.ts';
import { JOB_CHARTS, jobCharts, type JobChart } from './charts.ts';
import { escapeMarkdown, GAME_NAMES, GAME_SHORT, isGame, OUTCOME_LABELS } from './format.ts';
import { MONTH, WEEK } from './lists.ts';
import { booleanOption, GAME_OPTION, PRIVATE_OPTION, stringOption, subcommand, userOption } from './options.ts';

// /graph (owner, 2026-10-15): distance, fuel, damage and income as charts.
// - player: per day, week or month, or the running total (server history buckets);
// - job: speed, fuel, distance and damage over one job's time. Public only for valid
//   and approved jobs ("community prevents cheating"); moderators see every job in /review;
// - leaderboard: the top players side by side for one of those numbers.
// Distance is shown both ways: in game and at 1:1 (scored). Public unless `private`.

export const GRAPH_PLAYER_TASK = 'graph.player';
export const GRAPH_JOB_TASK = 'graph.job';
export const GRAPH_LEADERBOARD_TASK = 'graph.leaderboard';

export const METRICS = ['distance', 'fuel', 'damage', 'income'] as const;
export type Metric = (typeof METRICS)[number];

const L_PER_US_GAL = 3.785411784;
const LEADERBOARD_TOP = 15;

const METRIC_OPTION: APIApplicationCommandStringOption = {
  type: ApplicationCommandOptionType.String,
  name: 'metric',
  description: 'What to chart',
  required: true,
  choices: [
    { name: 'Distance (in game and 1:1)', value: 'distance' },
    { name: 'Fuel used', value: 'fuel' },
    { name: 'Cargo damage', value: 'damage' },
    { name: 'Income', value: 'income' },
  ],
};

export const graphCommand: CommandDefinition = {
  access: 'member',
  json: {
    name: 'graph',
    description: 'Charts of distance, fuel, damage and income: for a player, a job or the leaderboard',
    options: [
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'player',
        description: 'A player’s numbers per day, week or month, or their running total',
        options: [
          GAME_OPTION,
          METRIC_OPTION,
          { type: ApplicationCommandOptionType.User, name: 'user', description: 'Whose (default: yours)', required: false },
          {
            type: ApplicationCommandOptionType.String,
            name: 'per',
            description: 'Default: week (the last 12 weeks); day shows 30 days, month 12 months',
            required: false,
            choices: [
              { name: 'Day', value: 'day' },
              { name: 'Week', value: 'week' },
              { name: 'Month', value: 'month' },
            ],
          },
          { type: ApplicationCommandOptionType.Boolean, name: 'running_total', description: 'Show the all-time total as it grew, instead of each period', required: false },
          PRIVATE_OPTION,
        ],
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'job',
        description: 'Speed, fuel, distance and damage over a job (valid or approved jobs)',
        options: [
          { type: ApplicationCommandOptionType.String, name: 'id', description: 'Job ID, like 7K2M-9QXA', required: true, min_length: 8, max_length: 12 },
          {
            type: ApplicationCommandOptionType.String,
            name: 'chart',
            description: 'Default: all of them',
            required: false,
            choices: [
              { name: 'Speed', value: 'speed' },
              { name: 'Fuel', value: 'fuel' },
              { name: 'Distance', value: 'distance' },
              { name: 'Cargo damage', value: 'damage' },
            ],
          },
          PRIVATE_OPTION,
        ],
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'leaderboard',
        description: `The top ${LEADERBOARD_TOP} players side by side`,
        options: [
          GAME_OPTION,
          METRIC_OPTION,
          {
            type: ApplicationCommandOptionType.String,
            name: 'period',
            description: 'Default: all-time',
            required: false,
            choices: [
              { name: 'All-time', value: 'all' },
              { name: 'Month', value: 'month' },
              { name: 'Week (ISO, from Monday)', value: 'week' },
            ],
          },
          { type: ApplicationCommandOptionType.String, name: 'when', description: 'A past month like 2026-10, or week like 2026-W42', required: false, max_length: 8 },
          {
            type: ApplicationCommandOptionType.String,
            name: 'division',
            description: 'Default: everyone',
            required: false,
            choices: [
              { name: 'Everyone', value: 'all' },
              { name: 'Singleplayer Division', value: 'singleplayer' },
            ],
          },
          PRIVATE_OPTION,
        ],
      },
    ],
  },
  handle: ({ interaction, userId }) => {
    const sub = subcommand(interaction);
    const priv = booleanOption(interaction, 'private') ?? false;
    const reply = (content: string) => ({ kind: 'reply' as const, ephemeral: true, message: { content } });
    if (sub === 'job') {
      const jobId = parseJobId(stringOption(interaction, 'id') ?? '');
      if (!jobId) return reply('That isn’t a job ID. Job IDs look like `7K2M-9QXA`.');
      const chart = stringOption(interaction, 'chart');
      const input: JobGraphInput = { jobId, charts: chart && (JOB_CHARTS as readonly string[]).includes(chart) ? [chart as JobChart] : [...JOB_CHARTS], private: priv };
      return { kind: 'defer', ephemeral: priv, task: { name: GRAPH_JOB_TASK, input } };
    }
    const game = stringOption(interaction, 'game');
    const metric = stringOption(interaction, 'metric');
    if (!isGame(game)) return reply('Pick ETS2 or ATS.');
    if (!(METRICS as readonly string[]).includes(metric ?? '')) return reply('Pick what to chart.');
    if (sub === 'player') {
      const input: PlayerGraphInput = {
        game,
        metric: metric as Metric,
        target: userOption(interaction, 'user') ?? userId,
        bucket: (stringOption(interaction, 'per') ?? 'week') as HistoryBucket,
        running: booleanOption(interaction, 'running_total') ?? false,
        private: priv,
      };
      return { kind: 'defer', ephemeral: priv, task: { name: GRAPH_PLAYER_TASK, input } };
    }
    if (sub === 'leaderboard') {
      const period = (stringOption(interaction, 'period') ?? 'all') as LeaderboardPeriod;
      const at = stringOption(interaction, 'when')?.trim().toUpperCase() || null;
      if (at && !((period === 'month' && MONTH.test(at)) || (period === 'week' && WEEK.test(at)))) {
        return reply('`when` needs `period`: a month like `2026-10` with period Month, or a week like `2026-W42` with period Week.');
      }
      const division = (stringOption(interaction, 'division') === 'singleplayer' ? 'singleplayer' : 'all') as Division;
      const input: LeaderboardGraphInput = { game, metric: metric as Metric, period, at, division, private: priv };
      return { kind: 'defer', ephemeral: priv, task: { name: GRAPH_LEADERBOARD_TASK, input } };
    }
    return reply('Unknown subcommand.');
  },
};

// ---------------------------------------------------------------------------
// Units

/** Fuel in the game's usual unit: litres in ETS2, US gallons in ATS. */
export function fuelIn(game: Game, litres: number): number {
  return game === 'ats' ? round2(litres / L_PER_US_GAL) : round2(litres);
}
const fuelUnit = (game: Game) => (game === 'ats' ? 'gal' : 'L');
const money = (currency: string) => (currency === 'EUR' ? '€' : currency === 'USD' ? '$' : currency);
const round2 = (n: number) => Math.round(n * 100) / 100;

/** One chart's numbers from a set of totals. Distance has two charts. */
interface Series {
  key: string;
  label: string;
  unit: string;
  pick: (t: HistoryTotals) => number | null;
}

function seriesFor(metric: Metric, game: Game, currency: string): Series[] {
  switch (metric) {
    case 'distance':
      return [
        { key: 'distance-game', label: 'distance in game', unit: 'mi', pick: (t) => t.game_mi },
        { key: 'distance-world', label: 'distance at 1:1 (scored)', unit: 'mi', pick: (t) => t.world_mi },
      ];
    case 'fuel':
      return [{ key: 'fuel', label: 'fuel used', unit: fuelUnit(game), pick: (t) => fuelIn(game, t.fuel_used_l) }];
    case 'damage':
      return [{ key: 'damage', label: 'average cargo damage', unit: '%', pick: (t) => t.damage_pct_avg }];
    case 'income':
      return [{ key: 'income', label: 'income', unit: money(currency), pick: (t) => t.income }];
  }
}

function formatValue(v: number | null, unit: string): string {
  if (v === null) return '—';
  const n = round2(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
  return unit === '€' || unit === '$' ? `${v < 0 ? '−' : ''}${unit}${n.replace('-', '')}` : `${n} ${unit}`;
}

// ---------------------------------------------------------------------------
// Player

interface PlayerGraphInput {
  game: Game;
  metric: Metric;
  target: string;
  bucket: HistoryBucket;
  running: boolean;
  private: boolean;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** ISO week number of a UTC date. */
export function isoWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
}

/** Short x-axis labels: "Oct 14", "W42", "Oct 2026". */
export function bucketLabel(start: string, bucket: HistoryBucket): string {
  const d = new Date(start);
  if (bucket === 'week') return `W${isoWeek(d)}`;
  if (bucket === 'month') return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

const notLinked = (self: boolean) => (self ? 'You haven’t linked PlasmaTrack yet. Use `/token new` to start.' : 'That player hasn’t linked PlasmaTrack.');

export const graphPlayerTask: TaskDefinition = {
  name: GRAPH_PLAYER_TASK,
  async run(input, { interaction, deps }) {
    const { game, metric, target, bucket, running, private: priv } = input as PlayerGraphInput;
    const api = requireApi(deps);
    const self = target === interaction.userId;
    const player = await api.getPlayer(target).catch((err: unknown) => {
      throw apiFailure(err, { notFound: notLinked(self) });
    });
    const flags = priv ? MessageFlags.Ephemeral : 0;
    if (!player.linked) return { message: { content: notLinked(self), flags } };
    const history = await api.getPlayerHistory(game, target, { bucket }).catch((err: unknown) => {
      throw apiFailure(err, { notFound: notLinked(self) });
    });

    const name = player.display_name;
    const per = { day: 'per day', week: 'per week', month: 'per month' }[bucket];
    const labels = history.items.map((i) => bucketLabel(i.start, bucket));
    const charts = seriesFor(metric, game, history.currency).map((s) => {
      const values = history.items.map((i) => {
        // Damage is an average: a period without jobs has none, rather than 0 %.
        if (!running && s.key === 'damage' && i.job_count === 0) return null;
        return s.pick(running ? i.running : i);
      });
      const request: BarsRenderRequest = {
        title: `${name} · ${GAME_SHORT[game]} · ${s.label} ${running ? '(running total)' : per}`.slice(0, 100),
        unit: s.unit,
        kind: running ? 'line' : 'columns',
        labels,
        values,
      };
      return { s, request };
    });
    const rendered = await renderAll(charts.map((c) => ({ key: c.s.key, title: c.s.label, request: c.request })), deps);

    const total = history.items.at(-1)?.running ?? history.before;
    const inRange = sumTotals(history);
    const lines = seriesFor(metric, game, history.currency).map((s) =>
      running
        ? `All-time ${s.label}: **${formatValue(s.pick(total), s.unit)}**`
        : `${capital(s.label)} in these ${history.items.length} ${bucket}s: **${formatValue(s.key === 'damage' ? weightedDamage(history) : s.pick(inRange), s.unit)}**`,
    );
    lines.push(`${inRange.job_count} counted job${inRange.job_count === 1 ? '' : 's'} in this range.`);
    const embeds: APIEmbed[] = [
      {
        title: `${escapeMarkdown(name)} · ${GAME_NAMES[game]}`,
        description: `<@${target}>\n${lines.join('\n')}`,
        footer: { text: 'Valid and approved jobs, by delivery time in UTC.' },
      },
    ];
    return withCharts(embeds, rendered, flags);
  },
};

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function sumTotals(h: PlayerHistory): HistoryTotals {
  const t: HistoryTotals = { job_count: 0, points: 0, world_km: 0, world_mi: 0, game_km: 0, game_mi: 0, fuel_used_l: 0, income: 0, damage_pct_avg: null };
  for (const i of h.items) {
    t.job_count += i.job_count;
    t.points += i.points;
    t.world_km += i.world_km;
    t.world_mi += i.world_mi;
    t.game_km += i.game_km;
    t.game_mi += i.game_mi;
    t.fuel_used_l += i.fuel_used_l;
    t.income += i.income;
  }
  return t;
}

/** Average damage over the range, weighting each period by its jobs. */
function weightedDamage(h: PlayerHistory): number | null {
  let jobs = 0;
  let sum = 0;
  for (const i of h.items) {
    if (i.damage_pct_avg === null || i.job_count === 0) continue;
    jobs += i.job_count;
    sum += i.damage_pct_avg * i.job_count;
  }
  return jobs > 0 ? sum / jobs : null;
}

// ---------------------------------------------------------------------------
// Job

interface JobGraphInput {
  jobId: string;
  charts: JobChart[];
  private: boolean;
}

export const graphJobTask: TaskDefinition = {
  name: GRAPH_JOB_TASK,
  async run(input, { deps }) {
    const { jobId, charts, private: priv } = input as JobGraphInput;
    const api = requireApi(deps);
    const id = formatJobId(jobId);
    const job = await api.getJob(jobId).catch((err: unknown) => {
      throw apiFailure(err, { notFound: `No job with ID ${id}.` });
    });
    if (job.origin === 'manual') throw new UserFacingError(`Job ${id} was submitted by hand, so it has no recording to chart.`);
    if (job.outcome !== 'valid' && job.outcome !== 'approved') {
      throw new UserFacingError(`Job ${id} is ${OUTCOME_LABELS[job.outcome].toLowerCase()}. Its graphs are public once it’s valid or approved; until then only moderators see them, in \`/review job\`.`);
    }
    const series = await api.getJobSeries(jobId).catch((err: unknown) => {
      // Approved but no recording kept, or changed in between: nothing to chart.
      if (err instanceof ApiError && err.status === 404) return null;
      throw apiFailure(err);
    });
    if (!series || series.points.length === 0) throw new UserFacingError(`Job ${id} has no recording to chart.`);
    const title = `Job ${id}`;
    const rendered = await jobCharts(series, title, deps, charts);
    const missingDamage = charts.includes('damage') && !rendered.some((c) => c.name === 'damage.png');
    const embeds: APIEmbed[] = [
      {
        title: `${title} · ${GAME_NAMES[job.game]} · ${OUTCOME_LABELS[job.outcome]}`,
        description: `**${escapeMarkdown(job.cargo.name)}**: ${escapeMarkdown(job.source.city_name)} → ${escapeMarkdown(job.destination.city_name)}`,
        footer: {
          text: [
            'Parts undone by loading a save are left out.',
            missingDamage ? 'No damage readings: this job was recorded before they were kept.' : null,
          ]
            .filter(Boolean)
            .join(' '),
        },
      },
    ];
    return withCharts(
      embeds,
      rendered.map((c) => ({ name: c.name, title: c.title, bytes: c.bytes })),
      priv ? MessageFlags.Ephemeral : 0,
    );
  },
};

// ---------------------------------------------------------------------------
// Leaderboard

interface LeaderboardGraphInput {
  game: Game;
  metric: Metric;
  period: LeaderboardPeriod;
  at: string | null;
  division: Division;
  private: boolean;
}

export const graphLeaderboardTask: TaskDefinition = {
  name: GRAPH_LEADERBOARD_TASK,
  async run(input, { deps }) {
    const { game, metric, period, at, division, private: priv } = input as LeaderboardGraphInput;
    const api = requireApi(deps);
    const flags = priv ? MessageFlags.Ephemeral : 0;
    const periodText = period === 'all' ? 'all-time' : `${period === 'month' ? 'month' : 'week'}${at ? ` ${at}` : ''}`;
    // Distance is ranked once by each measure; damage ranks least damage first.
    const sorts: { sort: LeaderboardSort; s: (cur: string) => Series }[] =
      metric === 'distance'
        ? [
            { sort: 'game_distance', s: () => seriesFor('distance', game, '')[0]! },
            { sort: 'distance', s: () => seriesFor('distance', game, '')[1]! },
          ]
        : [{ sort: metric, s: (cur) => seriesFor(metric, game, cur)[0]! }];

    const charts: { key: string; title: string; request: BarsRenderRequest }[] = [];
    for (const { sort, s } of sorts) {
      const board = await api.getLeaderboard(game, { period, ...(at ? { at } : {}), division, sort, limit: LEADERBOARD_TOP }).catch((err: unknown) => {
        throw apiFailure(err);
      });
      const series = s(board.currency ?? '');
      // Players with no reading (damage only) can't be drawn as a bar.
      const items = board.items
        .map((e) => ({ e, v: valueOf(series.key, game, e) }))
        .filter((x) => x.v !== null);
      if (items.length === 0) continue;
      charts.push({
        key: series.key,
        title: series.label,
        request: {
          title: `${GAME_SHORT[game]} · ${series.label} · ${periodText}${division === 'singleplayer' ? ' · Singleplayer Division' : ''}`.slice(0, 100),
          unit: series.unit,
          kind: 'rows',
          height: Math.min(2048, 80 + items.length * 34),
          labels: items.map((x) => x.e.display_name.slice(0, 40)),
          values: items.map((x) => x.v),
          value_labels: items.map((x) => formatValue(x.v, series.unit).slice(0, 24)),
        },
      });
    }
    if (charts.length === 0) return { message: { content: `No one has ${metric === 'damage' ? 'damage readings' : 'counted jobs'} here yet.`, flags } };
    const rendered = await renderAll(charts, deps);
    const embeds: APIEmbed[] = [
      {
        title: `${GAME_NAMES[game]} · top ${LEADERBOARD_TOP} by ${metric === 'damage' ? 'least cargo damage' : metric}`,
        description: `Period: ${periodText} (UTC). ${metric === 'damage' ? 'Average cargo damage per job; lower is better.' : ''}`.trim(),
        footer: { text: 'Valid and approved jobs. Full rankings by points: /leaderboard' },
      },
    ];
    return withCharts(embeds, rendered, flags);
  },
};

function valueOf(key: string, game: Game, e: { game_mi: number; world_mi: number; fuel_used_l?: number | null; income?: number | null; damage_pct_avg?: number | null }): number | null {
  switch (key) {
    case 'distance-game':
      return e.game_mi;
    case 'distance-world':
      return e.world_mi;
    case 'fuel':
      return e.fuel_used_l === null || e.fuel_used_l === undefined ? null : fuelIn(game, e.fuel_used_l);
    case 'income':
      return e.income ?? null;
    default:
      return e.damage_pct_avg ?? null;
  }
}

// ---------------------------------------------------------------------------

interface Rendered {
  name: string;
  title: string;
  bytes: Uint8Array<ArrayBuffer>;
}

async function renderAll(charts: { key: string; title: string; request: BarsRenderRequest }[], deps: Pick<TaskDeps, 'renderer' | 'logger'>): Promise<Rendered[]> {
  const out = await Promise.all(
    charts.map(async (c) => {
      try {
        return { name: `${c.key}.png`, title: capital(c.title), bytes: (await deps.renderer.renderBars(c.request)).bytes };
      } catch (err) {
        deps.logger.warn('chart unavailable', { err, chart: c.key });
        return null;
      }
    }),
  );
  return out.filter((r): r is Rendered => r !== null);
}

function withCharts(embeds: APIEmbed[], charts: Rendered[], flags: number) {
  const files: OutgoingFile[] = [];
  for (const c of charts) {
    files.push({ name: c.name, bytes: c.bytes, contentType: 'image/png', description: c.title });
    embeds.push({ title: c.title, image: { url: `attachment://${c.name}` } });
  }
  if (charts.length === 0) embeds[0]!.footer = { text: 'The charts aren’t available right now. Try again in a minute.' };
  return { message: { embeds, flags }, files };
}
