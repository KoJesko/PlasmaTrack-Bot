import type { APIActionRowComponent, APIButtonComponent, APIEmbed } from 'discord-api-types/v10';
import { apiFailure, requireApi } from '../api/errors.ts';
import { formatJobId } from '../api/ids.ts';
import type { Division, Game, LeaderboardPeriod } from '../api/schemas.ts';
import { ApplicationCommandOptionType, ButtonStyle, ComponentType, MessageFlags } from '../discord/constants.ts';
import type { OutgoingMessage } from '../discord/rest.ts';
import type { CommandDefinition, ComponentDefinition, TaskDefinition } from '../interactions/types.ts';
import { discordTime, distance, escapeMarkdown, GAME_NAMES, isGame, OUTCOME_LABELS, pointsText } from './format.ts';
import { booleanOption, GAME_OPTION, PRIVATE_OPTION, stringOption, userOption } from './options.ts';

// /jobs and /leaderboard: paginated lists. The page state (including the
// server's cursor, at most 64 characters: API_CONVENTIONS §5) lives in the
// buttons' custom_id, so nothing is stored. Cursors only go forward, so the
// buttons are "Next" and "First page".

export const JOBS_TASK = 'jobs.list';
export const LEADERBOARD_TASK = 'leaderboard.show';
const PAGE = 10;
const CURSOR = /^[\x21-\x7e]{1,64}$/;

// ---------------------------------------------------------------------------
// /jobs

interface JobsInput {
  game: Game;
  target: string;
  cursor: string | null;
  private: boolean;
}

export const jobsCommand: CommandDefinition = {
  access: 'member',
  json: {
    name: 'jobs',
    description: 'A player’s recent jobs in one game',
    options: [
      GAME_OPTION,
      { type: ApplicationCommandOptionType.User, name: 'user', description: 'Whose jobs (default: yours)', required: false },
      PRIVATE_OPTION,
    ],
  },
  handle: ({ interaction, userId }) => {
    const game = stringOption(interaction, 'game');
    if (!isGame(game)) return { kind: 'reply', ephemeral: true, message: { content: 'Pick ETS2 or ATS.' } };
    const priv = booleanOption(interaction, 'private') ?? false;
    const input: JobsInput = { game, target: userOption(interaction, 'user') ?? userId, cursor: null, private: priv };
    return { kind: 'defer', ephemeral: priv, task: { name: JOBS_TASK, input } };
  },
};

// custom_id: "jobs:{game}:{discord id}:{p|-}:{cursor}" (≤ 100 characters)
export const jobsComponent: ComponentDefinition = {
  prefix: 'jobs',
  access: 'member',
  handle: (_ctx, arg) => {
    const [game, target, vis, ...rest] = arg.split(':');
    const cursor = rest.join(':');
    if (!isGame(game) || !target || !/^\d{17,20}$/.test(target) || (cursor !== '' && !CURSOR.test(cursor))) {
      return { kind: 'update', message: { content: 'This list has expired. Run `/jobs` again.', embeds: [], components: [] } };
    }
    const input: JobsInput = { game, target, cursor: cursor || null, private: vis === 'p' };
    return { kind: 'defer-update', task: { name: JOBS_TASK, input } };
  },
};

export const jobsTask: TaskDefinition = {
  name: JOBS_TASK,
  async run(input, { interaction, deps }) {
    const { game, target, cursor, private: priv } = input as JobsInput;
    const api = requireApi(deps);
    const page = await api.listPlayerJobs(game, target, { limit: PAGE, cursor }).catch((err: unknown) => {
      throw apiFailure(err, { notFound: target === interaction.userId ? 'You haven’t linked PlasmaTrack yet. Use `/token new` to start.' : 'That player hasn’t linked PlasmaTrack.' });
    });
    const lines = page.items.map(
      (j) =>
        `\`${formatJobId(j.job_id)}\` ${OUTCOME_LABELS[j.outcome]} · ${pointsText(j.outcome, j.points, j.held_points)} pts · ` +
        `${distance(j.world_mi, j.world_km)} · ${escapeMarkdown(j.source.city_name)} → ${escapeMarkdown(j.destination.city_name)} · ${discordTime(j.delivered_at, 'd')}`,
    );
    const embed: APIEmbed = {
      title: `${GAME_NAMES[game]} jobs`,
      description: lines.length > 0 ? `<@${target}>\n\n${lines.join('\n')}` : `<@${target}> has no finished ${game.toUpperCase()} jobs yet.`,
      footer: { text: `${page.total !== undefined ? `${page.total} jobs · ` : ''}Distance driven (1:1). Details: /job id` },
    };
    const base = `jobs:${game}:${target}:${priv ? 'p' : '-'}`;
    return { message: withPager({ embeds: [embed], flags: priv ? MessageFlags.Ephemeral : 0 }, base, cursor, page.next_cursor) };
  },
};

// ---------------------------------------------------------------------------
// /leaderboard

const PERIOD_CODE: Record<LeaderboardPeriod, string> = { all: 'a', month: 'm', week: 'w' };
const CODE_PERIOD: Record<string, LeaderboardPeriod> = { a: 'all', m: 'month', w: 'week' };
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const WEEK = /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/;

interface LeaderboardInput {
  game: Game;
  period: LeaderboardPeriod;
  at: string | null;
  division: Division;
  cursor: string | null;
  private: boolean;
}

export const leaderboardCommand: CommandDefinition = {
  access: 'member',
  json: {
    name: 'leaderboard',
    description: 'Rankings for one game (all-time, month or week, in UTC)',
    options: [
      GAME_OPTION,
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
      {
        type: ApplicationCommandOptionType.String,
        name: 'when',
        description: 'A past month like 2026-10, or week like 2026-W42 (default: the current one)',
        required: false,
        max_length: 8,
      },
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
  handle: ({ interaction }) => {
    const game = stringOption(interaction, 'game');
    if (!isGame(game)) return { kind: 'reply', ephemeral: true, message: { content: 'Pick ETS2 or ATS.' } };
    const period = (stringOption(interaction, 'period') ?? 'all') as LeaderboardPeriod;
    const at = stringOption(interaction, 'when')?.trim().toUpperCase() || null;
    if (at) {
      const ok = (period === 'month' && MONTH.test(at)) || (period === 'week' && WEEK.test(at));
      if (!ok) {
        return {
          kind: 'reply',
          ephemeral: true,
          message: { content: '`when` needs `period`: a month like `2026-10` with period Month, or a week like `2026-W42` with period Week.' },
        };
      }
    }
    const division = (stringOption(interaction, 'division') === 'singleplayer' ? 'singleplayer' : 'all') as Division;
    const priv = booleanOption(interaction, 'private') ?? false;
    const input: LeaderboardInput = { game, period, at, division, cursor: null, private: priv };
    return { kind: 'defer', ephemeral: priv, task: { name: LEADERBOARD_TASK, input } };
  },
};

// custom_id: "lb:{game}:{a|m|w}:{at|-}:{a|s}:{p|-}:{cursor}" (≤ 100 characters)
export const leaderboardComponent: ComponentDefinition = {
  prefix: 'lb',
  access: 'member',
  handle: (_ctx, arg) => {
    const [game, p, at, d, vis, ...rest] = arg.split(':');
    const cursor = rest.join(':');
    const period = CODE_PERIOD[p ?? ''];
    const atOk = at === '-' || (at !== undefined && (MONTH.test(at) || WEEK.test(at)));
    if (!isGame(game) || !period || !atOk || (d !== 'a' && d !== 's') || (cursor !== '' && !CURSOR.test(cursor))) {
      return { kind: 'update', message: { content: 'This leaderboard has expired. Run `/leaderboard` again.', embeds: [], components: [] } };
    }
    const input: LeaderboardInput = {
      game,
      period,
      at: at === '-' ? null : at!,
      division: d === 's' ? 'singleplayer' : 'all',
      cursor: cursor || null,
      private: vis === 'p',
    };
    return { kind: 'defer-update', task: { name: LEADERBOARD_TASK, input } };
  },
};

export const leaderboardTask: TaskDefinition = {
  name: LEADERBOARD_TASK,
  async run(input, { interaction, deps }) {
    const { game, period, at, division, cursor, private: priv } = input as LeaderboardInput;
    const api = requireApi(deps);
    const board = await api
      .getLeaderboard(game, { period, ...(at ? { at } : {}), division, limit: PAGE, cursor })
      .catch((err: unknown) => {
        throw apiFailure(err);
      });
    const lines = board.items.map((e) => {
      const name = escapeMarkdown(e.display_name);
      const me = e.discord_user_id === interaction.userId ? ' ← you' : '';
      return `**${e.rank}.** ${name} · **${e.points}** pts · ${e.job_count} job${e.job_count === 1 ? '' : 's'} · ${distance(e.world_mi, e.world_km)}${me}`;
    });
    const periodText =
      period === 'all' ? 'All-time' : board.period_start ? `${period === 'month' ? 'Month' : 'Week'} from ${discordTime(board.period_start, 'D')}` : period;
    const embed: APIEmbed = {
      title: `${GAME_NAMES[game]}${division === 'singleplayer' ? ' · Singleplayer Division' : ''}`,
      description: `${periodText}${board.at ? ` (${board.at})` : ''}\n\n${lines.length > 0 ? lines.join('\n') : 'No one has points here yet.'}`,
      footer: { text: `Distance driven (1:1). Periods are in UTC; results can take up to a minute to appear.` },
    };
    const base = `lb:${game}:${PERIOD_CODE[period]}:${at ?? '-'}:${division === 'singleplayer' ? 's' : 'a'}:${priv ? 'p' : '-'}`;
    return { message: withPager({ embeds: [embed], flags: priv ? MessageFlags.Ephemeral : 0 }, base, cursor, board.next_cursor) };
  },
};

// ---------------------------------------------------------------------------

function withPager(message: OutgoingMessage, base: string, current: string | null, next: string | null): OutgoingMessage {
  const buttons: APIButtonComponent[] = [];
  if (current) buttons.push({ type: ComponentType.Button, style: ButtonStyle.Secondary, custom_id: `${base}:`, label: 'First page' });
  if (next && CURSOR.test(next) && `${base}:${next}`.length <= 100) {
    buttons.push({ type: ComponentType.Button, style: ButtonStyle.Primary, custom_id: `${base}:${next}`, label: 'Next' });
  }
  const row: APIActionRowComponent<APIButtonComponent> = { type: ComponentType.ActionRow, components: buttons };
  return { ...message, components: buttons.length > 0 ? [row] : [] };
}
