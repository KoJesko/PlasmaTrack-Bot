import type { APIActionRowComponent, APIButtonComponent, APIEmbed, APIEmbedField } from 'discord-api-types/v10';
import { apiFailure, requireApi } from '../api/errors.ts';
import { formatJobId } from '../api/ids.ts';
import { GAMES, OUTCOMES, type GameStats, type Outcome } from '../api/schemas.ts';
import { ApplicationCommandOptionType, ButtonStyle, ComponentType, MessageFlags } from '../discord/constants.ts';
import type { OutgoingMessage } from '../discord/rest.ts';
import type { CommandDefinition, ComponentDefinition, TaskDefinition } from '../interactions/types.ts';
import { SCALE_CLASS_LABELS, SCALE_CLASSES } from '../render/protocol.ts';
import { discordTime, distance, escapeMarkdown, GAME_NAMES, GAME_SHORT, OUTCOME_LABELS, pointsText } from './format.ts';
import { booleanOption, PRIVATE_OPTION, stringOption, userOption } from './options.ts';

// One player's overall picture (owner, 2026-10-15):
// - /stats: totals for both games and each game, outcomes and distance by map scale;
// - /history: every finished job across both games, newest first, page by page.
// Public unless `private: True`, like /profile and /jobs.

export const STATS_TASK = 'stats.show';
export const HISTORY_TASK = 'history.list';
const PAGE = 10;
const CURSOR = /^[\x21-\x7e]{1,64}$/;

const notLinked = (self: boolean) => (self ? 'You haven’t linked PlasmaTrack yet. Use `/token new` to start.' : 'That player hasn’t linked PlasmaTrack.');

// ---------------------------------------------------------------------------
// /stats

interface StatsInput {
  target: string;
  private: boolean;
}

export const statsCommand: CommandDefinition = {
  access: 'member',
  json: {
    name: 'stats',
    description: 'A player’s overall PlasmaTrack stats: both games, outcomes and distance by map scale',
    options: [{ type: ApplicationCommandOptionType.User, name: 'user', description: 'Whose stats (default: yours)', required: false }, PRIVATE_OPTION],
  },
  handle: ({ interaction, userId }) => {
    const priv = booleanOption(interaction, 'private') ?? false;
    const input: StatsInput = { target: userOption(interaction, 'user') ?? userId, private: priv };
    return { kind: 'defer', ephemeral: priv, task: { name: STATS_TASK, input } };
  },
};

const round2 = (n: number) => Math.round(n * 100) / 100;

export const statsTask: TaskDefinition = {
  name: STATS_TASK,
  async run(input, { interaction, deps }) {
    const { target, private: priv } = input as StatsInput;
    const api = requireApi(deps);
    const player = await api.getPlayer(target).catch((err: unknown) => {
      throw apiFailure(err, { notFound: notLinked(target === interaction.userId) });
    });
    const flags = priv ? MessageFlags.Ephemeral : 0;
    if (!player.linked) return { message: { content: notLinked(target === interaction.userId), flags } };

    const per = GAMES.map((g) => [g, player.stats[g]] as const);
    const sum = (f: (s: GameStats) => number) => round2(per.reduce((n, [, s]) => n + f(s), 0));
    const fields: APIEmbedField[] = [
      {
        name: 'Both games',
        value: [
          `**${sum((s) => s.points)}** points from ${sum((s) => s.job_count)} counted jobs`,
          `Driven (1:1): ${distance(sum((s) => s.world_mi), sum((s) => s.world_km))}`,
          `In game: ${distance(sum((s) => s.game_mi), sum((s) => s.game_km))}`,
          `In review: ${sum((s) => s.pending_review_count)}`,
        ].join('\n'),
      },
    ];
    for (const [game, s] of per) {
      const lines = [
        `**${s.points}** points from ${s.job_count} counted jobs`,
        `Driven (1:1): ${distance(s.world_mi, s.world_km)} · in game: ${distance(s.game_mi, s.game_km)}`,
      ];
      const outcomes = outcomeLine(s.outcomes);
      if (outcomes) lines.push(outcomes);
      for (const c of SCALE_CLASSES) {
        const d = s.distance_by_scale_class?.[c];
        if (!d || (d.world_km === 0 && d.game_km === 0)) continue;
        lines.push(`${SCALE_CLASS_LABELS[c]}: ${distance(d.world_mi, d.world_km)} driven`);
      }
      fields.push({ name: GAME_NAMES[game], value: lines.join('\n').slice(0, 1024) });
    }
    const embed: APIEmbed = {
      title: `${escapeMarkdown(player.display_name)} · PlasmaTrack stats`,
      description: `<@${target}>`,
      fields,
      footer: { text: 'Points and distances count valid and approved jobs. Every job: /history' },
    };
    return { message: { embeds: [embed], flags } };
  },
};

function outcomeLine(outcomes: Record<string, number> | undefined): string | null {
  if (!outcomes) return null;
  const parts = OUTCOMES.filter((o) => (outcomes[o] ?? 0) > 0).map((o) => `${outcomes[o]} ${OUTCOME_LABELS[o].toLowerCase()}`);
  return parts.length > 0 ? `Jobs: ${parts.join(' · ')}` : null;
}

// ---------------------------------------------------------------------------
// /history

/** One character per outcome, to fit the page state in a 100-character custom_id. */
const OUTCOME_CODE: Record<(typeof OUTCOMES)[number], string> = {
  valid: 'v',
  approved: 'a',
  pending_review: 'p',
  invalid: 'i',
  rejected: 'r',
  discarded: 'd',
  voided: 'x',
};
const CODE_OUTCOME = Object.fromEntries(Object.entries(OUTCOME_CODE).map(([o, c]) => [c, o])) as Record<string, (typeof OUTCOMES)[number]>;

interface HistoryInput {
  target: string;
  outcome: (typeof OUTCOMES)[number] | null;
  cursor: string | null;
  private: boolean;
}

export const historyCommand: CommandDefinition = {
  access: 'member',
  json: {
    name: 'history',
    description: 'Every finished job of a player, both games, newest first',
    options: [
      { type: ApplicationCommandOptionType.User, name: 'user', description: 'Whose jobs (default: yours)', required: false },
      {
        type: ApplicationCommandOptionType.String,
        name: 'outcome',
        description: 'Only jobs with this outcome (default: all)',
        required: false,
        choices: OUTCOMES.map((o) => ({ name: OUTCOME_LABELS[o], value: o })),
      },
      PRIVATE_OPTION,
    ],
  },
  handle: ({ interaction, userId }) => {
    const priv = booleanOption(interaction, 'private') ?? false;
    const outcome = stringOption(interaction, 'outcome');
    const input: HistoryInput = {
      target: userOption(interaction, 'user') ?? userId,
      outcome: outcome && outcome in OUTCOME_CODE ? (outcome as HistoryInput['outcome']) : null,
      cursor: null,
      private: priv,
    };
    return { kind: 'defer', ephemeral: priv, task: { name: HISTORY_TASK, input } };
  },
};

// custom_id: "hist:{discord id}:{p|-}:{outcome code|-}:{cursor}" (≤ 100 characters)
export const historyComponent: ComponentDefinition = {
  prefix: 'hist',
  access: 'member',
  handle: (_ctx, arg) => {
    const [target, vis, code, ...rest] = arg.split(':');
    const cursor = rest.join(':');
    if (!target || !/^\d{17,20}$/.test(target) || (code !== '-' && !(code! in CODE_OUTCOME)) || (cursor !== '' && !CURSOR.test(cursor))) {
      return { kind: 'update', message: { content: 'This list has expired. Run `/history` again.', embeds: [], components: [] } };
    }
    const input: HistoryInput = { target, outcome: code === '-' ? null : CODE_OUTCOME[code!]!, cursor: cursor || null, private: vis === 'p' };
    return { kind: 'defer-update', task: { name: HISTORY_TASK, input } };
  },
};

export const historyTask: TaskDefinition = {
  name: HISTORY_TASK,
  async run(input, { interaction, deps }) {
    const { target, outcome, cursor, private: priv } = input as HistoryInput;
    const api = requireApi(deps);
    const page = await api.listAllPlayerJobs(target, { limit: PAGE, cursor, ...(outcome ? { outcome: [outcome] } : {}) }).catch((err: unknown) => {
      throw apiFailure(err, { notFound: notLinked(target === interaction.userId) });
    });
    const lines = page.items.map(
      (j) =>
        `${GAME_SHORT[j.game]} \`${formatJobId(j.job_id)}\` ${OUTCOME_LABELS[j.outcome as Outcome]} · ${pointsText(j.outcome, j.points, j.held_points)} pts · ` +
        `${distance(j.world_mi, j.world_km)} · ${escapeMarkdown(j.source.city_name)} → ${escapeMarkdown(j.destination.city_name)} · ` +
        `${discordTime(j.delivered_at, 'd')}${j.origin === 'manual' ? ' · by hand' : ''}`,
    );
    const filter = outcome ? ` (${OUTCOME_LABELS[outcome].toLowerCase()})` : '';
    const embed: APIEmbed = {
      title: `Job history${filter}`,
      description: lines.length > 0 ? `<@${target}>\n\n${lines.join('\n')}`.slice(0, 4096) : `<@${target}> has no finished jobs${filter} yet.`,
      footer: { text: `${page.total !== undefined ? `${page.total} jobs · ` : ''}Distance driven (1:1). Details: /job id` },
    };
    const base = `hist:${target}:${priv ? 'p' : '-'}:${outcome ? OUTCOME_CODE[outcome] : '-'}`;
    return { message: withPager({ embeds: [embed], flags: priv ? MessageFlags.Ephemeral : 0 }, base, cursor, page.next_cursor) };
  },
};

function withPager(message: OutgoingMessage, base: string, current: string | null, next: string | null): OutgoingMessage {
  const buttons: APIButtonComponent[] = [];
  if (current) buttons.push({ type: ComponentType.Button, style: ButtonStyle.Secondary, custom_id: `${base}:`, label: 'First page' });
  if (next && CURSOR.test(next) && `${base}:${next}`.length <= 100) {
    buttons.push({ type: ComponentType.Button, style: ButtonStyle.Primary, custom_id: `${base}:${next}`, label: 'Next' });
  }
  const row: APIActionRowComponent<APIButtonComponent> = { type: ComponentType.ActionRow, components: buttons };
  return { ...message, components: buttons.length > 0 ? [row] : [] };
}
