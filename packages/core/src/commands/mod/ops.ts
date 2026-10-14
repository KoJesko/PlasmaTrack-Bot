import type { APIEmbed } from 'discord-api-types/v10';
import { idempotencyKey, type BonusInput } from '../../api/client.ts';
import { parseJobId } from '../../api/ids.ts';
import type { Bonus, Game } from '../../api/schemas.ts';
import { ApplicationCommandOptionType, ButtonStyle, ComponentType } from '../../discord/constants.ts';
import type { CommandDefinition, ComponentDefinition, ModalDefinition, TaskDefinition } from '../../interactions/types.ts';
import { discordTime, escapeMarkdown, GAME_SHORT, isGame } from '../format.ts';
import { numberOption, OPTIONAL_GAME_OPTION, stringOption, subcommand } from '../options.ts';
import { adminFor, modalValue, modFailure, parseUtc, privateMessage, REASON_OPTION, reasonModal } from './common.ts';
import { RECALC_JOB_TASK } from './review.ts';

// /recalc job | all | status, and /bonus list | create | edit | archive.

export const RECALC_ALL_TASK = 'mod.recalc.all';
export const RECALC_STATUS_TASK = 'mod.recalc.status';
export const BONUS_LIST_TASK = 'mod.bonus.list';
export const BONUS_WRITE_TASK = 'mod.bonus.write';

const optionalGame = OPTIONAL_GAME_OPTION;

// ---------------------------------------------------------------------------
// /recalc

export const recalcCommand: CommandDefinition = {
  access: 'moderator',
  json: {
    name: 'recalc',
    description: 'Re-score jobs with the current config and bonuses (moderators)',
    options: [
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'job',
        description: 'Re-score one job now',
        options: [{ type: ApplicationCommandOptionType.String, name: 'id', description: 'Job ID, like 7K2M-9QXA', required: true, min_length: 8, max_length: 12 }, REASON_OPTION],
      },
      { type: ApplicationCommandOptionType.Subcommand, name: 'all', description: 'Re-score every job (asks to confirm first)', options: [optionalGame] },
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'status',
        description: 'Progress of a running recalculation',
        options: [{ type: ApplicationCommandOptionType.String, name: 'operation', description: 'Operation ID, like op_9xk2', required: true, max_length: 64 }],
      },
    ],
  },
  handle: ({ interaction }) => {
    const sub = subcommand(interaction);
    if (sub === 'job') {
      const jobId = parseJobId(stringOption(interaction, 'id') ?? '');
      if (!jobId) return { kind: 'reply', ephemeral: true, message: { content: 'That isn’t a job ID. Job IDs look like `7K2M-9QXA`.' } };
      return { kind: 'defer', ephemeral: true, task: { name: RECALC_JOB_TASK, input: { jobId, reason: stringOption(interaction, 'reason') ?? '' } } };
    }
    if (sub === 'status') {
      const op = stringOption(interaction, 'operation')?.trim() ?? '';
      if (!/^op_[A-Za-z0-9_]{1,60}$/.test(op)) return { kind: 'reply', ephemeral: true, message: { content: 'Operation IDs look like `op_9xk2`.' } };
      return { kind: 'defer', ephemeral: true, task: { name: RECALC_STATUS_TASK, input: { operationId: op } } };
    }
    const game = stringOption(interaction, 'game');
    return { kind: 'defer', ephemeral: true, task: { name: RECALC_ALL_TASK, input: { game: isGame(game) ? game : null, reason: null } } };
  },
};

interface RecalcAllInput {
  game: Game | null;
  /** null: dry run (count and ask); a reason: really start. */
  reason: string | null;
}

export const recalcAllTask: TaskDefinition = {
  name: RECALC_ALL_TASK,
  async run(input, { interaction, deps }) {
    const { game, reason } = input as RecalcAllInput;
    const admin = adminFor(deps, interaction);
    const scope = game ? GAME_SHORT[game] : 'both games';
    try {
      if (reason === null) {
        // The dry run needs a reason too (it is a write call); it changes nothing.
        const dry = await admin.recalculationDryRun(game ?? undefined, {
          reason: 'Dry run before a recalculation',
          idempotencyKey: idempotencyKey(interaction.id, 'recalc.dry'),
        });
        return {
          message: privateMessage({
            content: `This would re-score **${dry.affected_jobs}** jobs in ${scope}. Moderator decisions keep their outcome; everything else is re-derived with the current config and bonuses.`,
            components: [
              {
                type: ComponentType.ActionRow,
                components: [
                  { type: ComponentType.Button, style: ButtonStyle.Danger, label: `Re-score ${dry.affected_jobs} jobs`, custom_id: `mrall:${game ?? '-'}` },
                  { type: ComponentType.Button, style: ButtonStyle.Secondary, label: 'Cancel', custom_id: 'mcancel' },
                ],
              },
            ],
          }),
        };
      }
      const started = await admin.startRecalculation(game ?? undefined, { reason, idempotencyKey: idempotencyKey(interaction.id, 'recalc.all') });
      return {
        message: privateMessage({
          content: `Started: re-scoring ${started.affected_jobs} jobs in ${scope} (operation \`${started.operation_id}\`). The review channel is told when it finishes; \`/recalc status\` shows progress.`,
          components: [],
        }),
      };
    } catch (err) {
      const e = err as { code?: string; details?: Record<string, unknown> };
      if (e.code === 'conflict' && typeof e.details?.['operation_id'] === 'string') {
        return { message: privateMessage({ content: `A recalculation is already running (\`${e.details['operation_id']}\`). Only one runs at a time.`, components: [] }) };
      }
      throw modFailure(err);
    }
  },
};

export const recalcComponents: ComponentDefinition[] = [
  {
    prefix: 'mrall',
    access: 'moderator',
    handle: (_ctx, arg) => ({ kind: 'modal', modal: reasonModal(`mrall:${isGame(arg) ? arg : '-'}`, 'Re-score every job') }),
  },
  {
    prefix: 'mcancel',
    access: 'moderator',
    handle: () => ({ kind: 'update', message: { content: 'Cancelled. Nothing changed.', components: [] } }),
  },
];

export const recalcModals: ModalDefinition[] = [
  {
    prefix: 'mrall',
    access: 'moderator',
    handle: ({ interaction }, arg) => ({
      kind: 'defer',
      ephemeral: true,
      task: { name: RECALC_ALL_TASK, input: { game: isGame(arg) ? arg : null, reason: modalValue(interaction, 'reason') ?? '' } },
    }),
  },
];

export const recalcStatusTask: TaskDefinition = {
  name: RECALC_STATUS_TASK,
  async run(input, { interaction, deps }) {
    const { operationId } = input as { operationId: string };
    const op = await adminFor(deps, interaction)
      .operation(operationId)
      .catch((err: unknown) => {
        throw modFailure(err, `No operation \`${operationId}\`.`);
      });
    const progress = op.progress ? ` · ${op.progress.done}/${op.progress.total}` : '';
    const summary = op.summary ? `\n${Object.entries(op.summary).map(([k, v]) => `• ${k}: ${JSON.stringify(v)}`).join('\n')}`.slice(0, 1500) : '';
    return {
      message: privateMessage({
        content: `\`${op.operation_id}\` (${op.kind}): **${op.status}**${progress}${op.started_at ? ` · started ${discordTime(op.started_at, 'R')}` : ''}${op.finished_at ? ` · finished ${discordTime(op.finished_at, 'R')}` : ''}${summary}`,
      }),
    };
  },
};

// ---------------------------------------------------------------------------
// /bonus

const amountHelp = 'Multiplier (e.g. 1.5) or flat points (e.g. 10)';

export const bonusCommand: CommandDefinition = {
  access: 'moderator',
  json: {
    name: 'bonus',
    description: 'Bonus cargo (moderators)',
    options: [
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'list',
        description: 'Bonuses, by status',
        options: [
          optionalGame,
          {
            type: ApplicationCommandOptionType.String,
            name: 'status',
            description: 'Default: active and scheduled',
            required: false,
            choices: ['active', 'scheduled', 'ended', 'archived'].map((s) => ({ name: s, value: s })),
          },
        ],
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'create',
        description: 'A new bonus (the window is in UTC; it is checked against the server’s delivery time)',
        options: [
          { ...optionalGame, required: true, description: 'Which game' },
          { type: ApplicationCommandOptionType.String, name: 'label', description: 'Name players see, e.g. Medical week', required: true, max_length: 60 },
          { type: ApplicationCommandOptionType.String, name: 'cargo', description: 'Cargo ID, or a pattern with * and ?, e.g. med_*', required: true, max_length: 64 },
          {
            type: ApplicationCommandOptionType.String,
            name: 'kind',
            description: 'Multiplier or flat points',
            required: true,
            choices: [
              { name: 'Multiplier (× points)', value: 'multiplier' },
              { name: 'Flat (+ points)', value: 'flat' },
            ],
          },
          { type: ApplicationCommandOptionType.Number, name: 'amount', description: amountHelp, required: true, min_value: 0.01 },
          { type: ApplicationCommandOptionType.String, name: 'from', description: 'Start, UTC: 2026-10-19 or 2026-10-19 18:00', required: true, max_length: 16 },
          { type: ApplicationCommandOptionType.String, name: 'to', description: 'End (not included), UTC: 2026-10-26', required: true, max_length: 16 },
          REASON_OPTION,
        ],
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'edit',
        description: 'Change a bonus (only the fields you give)',
        options: [
          { type: ApplicationCommandOptionType.String, name: 'id', description: 'Bonus ID, like bon_2kd8', required: true, max_length: 64 },
          REASON_OPTION,
          { type: ApplicationCommandOptionType.String, name: 'label', description: 'New name', required: false, max_length: 60 },
          { type: ApplicationCommandOptionType.Number, name: 'amount', description: amountHelp, required: false, min_value: 0.01 },
          { type: ApplicationCommandOptionType.String, name: 'from', description: 'New start, UTC', required: false, max_length: 16 },
          { type: ApplicationCommandOptionType.String, name: 'to', description: 'New end, UTC', required: false, max_length: 16 },
        ],
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'archive',
        description: 'Stop a bonus (jobs keep the bonus they were scored with)',
        options: [{ type: ApplicationCommandOptionType.String, name: 'id', description: 'Bonus ID, like bon_2kd8', required: true, max_length: 64 }, REASON_OPTION],
      },
    ],
  },
  handle: ({ interaction }) => {
    const sub = subcommand(interaction);
    const reply = (content: string) => ({ kind: 'reply' as const, ephemeral: true, message: { content } });
    if (sub === 'list') {
      const game = stringOption(interaction, 'game');
      return { kind: 'defer', ephemeral: true, task: { name: BONUS_LIST_TASK, input: { game: isGame(game) ? game : null, status: stringOption(interaction, 'status') ?? null } } };
    }
    const reason = stringOption(interaction, 'reason') ?? '';
    const id = stringOption(interaction, 'id')?.trim();
    if (sub === 'archive') {
      if (!id || !/^bon_[A-Za-z0-9_]{1,60}$/.test(id)) return reply('Bonus IDs look like `bon_2kd8`.');
      return { kind: 'defer', ephemeral: true, task: { name: BONUS_WRITE_TASK, input: { op: 'archive', id, reason } } };
    }
    const fromText = stringOption(interaction, 'from');
    const toText = stringOption(interaction, 'to');
    const from = fromText ? parseUtc(fromText) : undefined;
    const to = toText ? parseUtc(toText) : undefined;
    if (from === null || to === null) return reply('Dates are UTC, like `2026-10-19` or `2026-10-19 18:00`.');
    if (from && to && Date.parse(to) <= Date.parse(from)) return reply('The end has to be after the start.');
    const kind = stringOption(interaction, 'kind');
    const amount = numberOption(interaction, 'amount');
    if (sub === 'create') {
      const game = stringOption(interaction, 'game');
      const cargo = stringOption(interaction, 'cargo')?.trim().toLowerCase() ?? '';
      if (!isGame(game) || !from || !to || amount === undefined || (kind !== 'flat' && kind !== 'multiplier')) return reply('Something is missing.');
      if (!/^[a-z0-9_*?.-]{1,64}$/.test(cargo)) return reply('Cargo IDs are like `med_vaccine`; patterns can use `*` and `?`.');
      if (kind === 'multiplier' && amount <= 1) return reply('A multiplier has to be more than 1 (e.g. 1.5).');
      const bonus: BonusInput = {
        game,
        label: stringOption(interaction, 'label')?.trim() ?? '',
        match: cargo,
        match_kind: /[*?]/.test(cargo) ? 'glob' : 'exact',
        kind,
        amount,
        active_from: from,
        active_to: to,
      };
      return { kind: 'defer', ephemeral: true, task: { name: BONUS_WRITE_TASK, input: { op: 'create', bonus, reason } } };
    }
    if (!id || !/^bon_[A-Za-z0-9_]{1,60}$/.test(id)) return reply('Bonus IDs look like `bon_2kd8`.');
    const label = stringOption(interaction, 'label')?.trim();
    const changes: Partial<BonusInput> = {
      ...(label ? { label } : {}),
      ...(amount !== undefined ? { amount } : {}),
      ...(from ? { active_from: from } : {}),
      ...(to ? { active_to: to } : {}),
    };
    if (Object.keys(changes).length === 0) return reply('Give at least one thing to change.');
    return { kind: 'defer', ephemeral: true, task: { name: BONUS_WRITE_TASK, input: { op: 'edit', id, changes, reason } } };
  },
};

function bonusLine(b: Bonus): string {
  const amount = b.kind === 'multiplier' ? `×${b.amount}` : `+${b.amount} pts`;
  return `\`${b.bonus_id}\` **${escapeMarkdown(b.label)}** · ${GAME_SHORT[b.game]} · \`${b.match}\` ${amount} · ${discordTime(b.active_from, 'f')} → ${discordTime(b.active_to, 'f')} · ${b.status}`;
}

export const bonusListTask: TaskDefinition = {
  name: BONUS_LIST_TASK,
  async run(input, { interaction, deps }) {
    const { game, status } = input as { game: Game | null; status: string | null };
    const admin = adminFor(deps, interaction);
    const statuses = status ? [status] : ['active', 'scheduled'];
    const pages = await Promise.all(
      statuses.map((s) => admin.listBonuses({ limit: 25, status: s, ...(game ? { game } : {}) })),
    ).catch((err: unknown) => {
      throw modFailure(err);
    });
    const items = pages.flatMap((p) => p.items);
    const embed: APIEmbed = {
      title: `Bonuses (${statuses.join(', ')})`,
      description: items.length > 0 ? items.map(bonusLine).join('\n').slice(0, 4000) : 'None.',
      footer: { text: 'Only the biggest matching bonus applies to a job. Windows are UTC.' },
    };
    return { message: privateMessage({ embeds: [embed] }) };
  },
};

type BonusWrite =
  | { op: 'create'; bonus: BonusInput; reason: string }
  | { op: 'edit'; id: string; changes: Partial<BonusInput>; reason: string }
  | { op: 'archive'; id: string; reason: string };

export const bonusWriteTask: TaskDefinition = {
  name: BONUS_WRITE_TASK,
  async run(input, { interaction, deps }) {
    const w = input as BonusWrite;
    const admin = adminFor(deps, interaction);
    const meta = { reason: w.reason, idempotencyKey: idempotencyKey(interaction.id, `bonus.${w.op}`) };
    try {
      const b =
        w.op === 'create' ? await admin.createBonus(w.bonus, meta) : w.op === 'edit' ? await admin.updateBonus(w.id, w.changes, meta) : await admin.archiveBonus(w.id, meta);
      const verb = w.op === 'create' ? 'Created' : w.op === 'edit' ? 'Updated' : 'Archived';
      const hint = w.op === 'archive' ? '' : '\nJobs already scored keep their points; `/recalc all` applies it to them.';
      return { message: privateMessage({ content: `${verb}: ${bonusLine(b)}${hint}` }) };
    } catch (err) {
      throw modFailure(err, 'No bonus with that ID.');
    }
  },
};

export const opsTasks = [recalcAllTask, recalcStatusTask, bonusListTask, bonusWriteTask];
