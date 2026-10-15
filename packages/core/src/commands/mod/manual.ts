import type { APIApplicationCommandStringOption } from 'discord-api-types/v10';
import { idempotencyKey, type JobEdit } from '../../api/client.ts';
import { formatJobId, parseJobId } from '../../api/ids.ts';
import type { Decision } from '../../api/schemas.ts';
import { ApplicationCommandOptionType } from '../../discord/constants.ts';
import { UserFacingError, type CommandDefinition, type HandlerResult, type TaskDefinition } from '../../interactions/types.ts';
import { OUTCOME_LABELS, pointsText } from '../format.ts';
import { describeChanges, MAX_ADJUSTED_SECTIONS, readStatChanges, sectionOption, splitMods, STAT_OPTIONS, textOption } from '../manual-fields.ts';
import { booleanOption, numberOption, stringOption, subcommand } from '../options.ts';
import { adminFor, brief, modFailure, privateMessage, REASON_OPTION } from './common.ts';

// Manual jobs and corrections (owner, 2026-10-15). Replies are private.
//
// - /approve-manual, /decline-manual: decide a job submitted by hand.
//   Approval can correct any stat and hide the custom map in the same step.
// - /post-approve, /post-decline: reverse an earlier decision on any job.
// - /edit-job stats | details | clear: correct any field of any job; the
//   server keeps edits as overrides that survive re-scoring.

export const MANUAL_DECIDE_TASK = 'mod.manual.decide';
export const EDIT_JOB_TASK = 'mod.edit-job';

const DEFAULT_APPROVE_REASON = 'Manual submission approved.';

const JOB_ID_OPTION: APIApplicationCommandStringOption = {
  type: ApplicationCommandOptionType.String,
  name: 'job',
  description: 'Job ID, like 7K2M-9QXA',
  required: true,
  min_length: 8,
  max_length: 12,
};

const OPTIONAL_REASON: APIApplicationCommandStringOption = {
  ...REASON_OPTION,
  description: `Why (3–1000 characters; default: “${DEFAULT_APPROVE_REASON}”)`,
  required: false,
};

type Mode = 'approve-manual' | 'decline-manual' | 'post-approve' | 'post-decline';

interface DecideInput {
  mode: Mode;
  jobId: string;
  reason: string;
  hideMap?: boolean;
  corrections?: JobEdit;
}

const BAD_ID = { kind: 'reply', ephemeral: true, message: { content: 'That isn’t a job ID. Job IDs look like `7K2M-9QXA`.' } } as const;

function decide(mode: Mode, jobId: string | null, reason: string, extra: Partial<DecideInput> = {}): HandlerResult {
  if (!jobId) return BAD_ID;
  const input: DecideInput = { mode, jobId, reason, ...extra };
  return { kind: 'defer', ephemeral: true, task: { name: MANUAL_DECIDE_TASK, input } };
}

export const approveManualCommand: CommandDefinition = {
  access: 'moderator',
  json: {
    name: 'approve-manual',
    description: 'Approve a job submitted by hand, optionally correcting its stats (moderators)',
    options: [
      JOB_ID_OPTION,
      OPTIONAL_REASON,
      { type: ApplicationCommandOptionType.Boolean, name: 'hide_map', description: 'Keep the custom map out of the public /job view', required: false },
      ...STAT_OPTIONS,
    ],
  },
  handle: ({ interaction }) => {
    const { changes, problems } = readStatChanges(interaction);
    if (problems.length > 0) return { kind: 'reply', ephemeral: true, message: { content: problems.map((p) => `• ${p}`).join('\n') } };
    const hideMap = booleanOption(interaction, 'hide_map');
    return decide('approve-manual', parseJobId(stringOption(interaction, 'job') ?? ''), stringOption(interaction, 'reason')?.trim() || DEFAULT_APPROVE_REASON, {
      ...(hideMap !== undefined ? { hideMap } : {}),
      ...(Object.keys(changes).length > 0 ? { corrections: changes } : {}),
    });
  },
};

function simpleDecision(name: Mode, description: string): CommandDefinition {
  return {
    access: 'moderator',
    json: { name, description, options: [JOB_ID_OPTION, REASON_OPTION] },
    handle: ({ interaction }) => decide(name, parseJobId(stringOption(interaction, 'job') ?? ''), stringOption(interaction, 'reason') ?? ''),
  };
}

export const declineManualCommand = simpleDecision('decline-manual', 'Decline a job submitted by hand (moderators; a reason is required)');
export const postApproveCommand = simpleDecision('post-approve', 'Approve a job after all, reversing an earlier rejection (moderators)');
export const postDeclineCommand = simpleDecision('post-decline', 'Reject a job after all, reversing an earlier approval (moderators)');

export const manualDecideTask: TaskDefinition = {
  name: MANUAL_DECIDE_TASK,
  async run(input, { interaction, deps }) {
    const { mode, jobId, reason, hideMap, corrections } = input as DecideInput;
    const admin = adminFor(deps, interaction);
    const id = formatJobId(jobId);
    const job = await admin.job(jobId).catch((err: unknown) => {
      throw modFailure(err, `No job with ID ${id}.`);
    });
    const manual = job.origin === 'manual';
    if ((mode === 'approve-manual' || mode === 'decline-manual') && !manual) {
      throw new UserFacingError(`Job ${id} was recorded by the tracker, not submitted by hand. Use \`/post-${mode === 'approve-manual' ? 'approve' : 'decline'}\` or the buttons in \`/review job\`.`);
    }
    if ((hideMap !== undefined || corrections) && !manual) throw new UserFacingError('`hide_map` and corrections are for jobs submitted by hand.');
    const decision: Decision = mode === 'approve-manual' || mode === 'post-approve' ? 'approve' : 'reject';
    const result = await admin
      .decide(jobId, decision, {
        reason,
        idempotencyKey: idempotencyKey(interaction.id, `manual.${decision}`),
        expectedEtag: job.etag,
        ...(hideMap !== undefined ? { hideMap } : {}),
        ...(corrections ? { corrections } : {}),
      })
      .catch((err: unknown) => {
        throw modFailure(err, `No job with ID ${id}.`);
      });
    const lines = [
      `Job **${id}**: ${OUTCOME_LABELS[job.outcome]} → **${OUTCOME_LABELS[result.outcome]}**, ${pointsText(result.outcome, result.points, result.held_points)} points.`,
      ...(corrections ? [`Corrected: ${describeChanges(corrections).join('; ')}`] : []),
      ...(hideMap === true ? ['The custom map is hidden from the public view.'] : hideMap === false ? ['The custom map is public.'] : []),
    ];
    return { message: privateMessage({ content: lines.join('\n').slice(0, 2000) }) };
  },
};

// ---------------------------------------------------------------------------
// /edit-job

const CLEARABLE: Record<string, keyof JobEdit> = {
  damage: 'damage',
  profit: 'profit',
  fuel_used: 'fuel_used',
  truck: 'truck',
  truck_model: 'truck_model',
  mod_names: 'mod_names',
  map_scale: 'map_scale',
  uk: 'uk',
  adjusted_scales: 'adjusted_scales',
  bonus: 'bonus_id',
};
/** `section2` in /edit-job clear removes adjusted-scale section 2. */
const CLEAR_SECTION = /^section(\d)$/;
const CLEAR_HELP = `${Object.keys(CLEARABLE).join(', ')}, or section1 to section${MAX_ADJUSTED_SECTIONS} for one adjusted-scale section`;

export const editJobCommand: CommandDefinition = {
  access: 'moderator',
  json: {
    name: 'edit-job',
    description: 'Correct any field of any job; edits survive re-scoring (moderators)',
    options: [
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'stats',
        description: 'Distances, scales, fuel, damage, profit, times or the bonus',
        options: [JOB_ID_OPTION, REASON_OPTION, ...STAT_OPTIONS, textOption('bonus', 'Bonus ID to apply instead of the automatic choice, like bon_2kd8', false, 64)],
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'details',
        description: 'Places, cargo, truck, mods, and the UK or adjusted-scale city names',
        options: [
          JOB_ID_OPTION,
          REASON_OPTION,
          textOption('start', 'Pickup city', false),
          textOption('start_company', 'Pickup company', false),
          textOption('end', 'Delivery city', false),
          textOption('end_company', 'Delivery company', false),
          textOption('cargo_name', 'Cargo', false),
          textOption('truck', 'Truck brand', false),
          textOption('truck_model', 'Truck model', false),
          textOption('mod_names', 'Mods, separated by commas (replaces the list)', false, 1000),
          textOption('uk_entry_city', 'City where the UK stretch starts', false),
          textOption('uk_end_city', 'City where the UK stretch ends', false),
          sectionOption('Adjusted-scale section whose cities to correct, as /review numbers it'),
          textOption('adjusted_entry_city', 'City where that adjusted-scale section starts', false),
          textOption('adjusted_exit_city', 'City where it ends', false),
        ],
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'clear',
        description: 'Remove values: damage, profit, fuel_used, truck, truck_model, mod_names, map_scale, uk…',
        options: [
          JOB_ID_OPTION,
          REASON_OPTION,
          textOption('fields', `Comma-separated: ${CLEAR_HELP}`.slice(0, 100), true, 200),
        ],
      },
    ],
  },
  handle: ({ interaction }) => {
    const jobId = parseJobId(stringOption(interaction, 'job') ?? '');
    if (!jobId) return BAD_ID;
    const sub = subcommand(interaction);
    const reason = stringOption(interaction, 'reason') ?? '';
    let changes: JobEdit = {};
    const problems: string[] = [];
    if (sub === 'stats') {
      const read = readStatChanges(interaction);
      changes = read.changes;
      problems.push(...read.problems);
      const bonus = stringOption(interaction, 'bonus')?.trim();
      if (bonus) {
        if (/^bon_[A-Za-z0-9_]{1,60}$/.test(bonus)) changes.bonus_id = bonus;
        else problems.push('Bonus IDs look like `bon_2kd8`.');
      }
    } else if (sub === 'details') {
      const text = (name: string) => stringOption(interaction, name)?.trim() || undefined;
      const set = <K extends keyof JobEdit>(k: K, v: JobEdit[K] | undefined) => {
        if (v !== undefined) changes[k] = v;
      };
      set('start_city', text('start'));
      set('start_company', text('start_company'));
      set('end_city', text('end'));
      set('end_company', text('end_company'));
      set('cargo_name', text('cargo_name'));
      set('truck', text('truck'));
      set('truck_model', text('truck_model'));
      const mods = text('mod_names');
      if (mods) changes.mod_names = splitMods(mods);
      const ukEntry = text('uk_entry_city');
      const ukEnd = text('uk_end_city');
      if (ukEntry || ukEnd) changes.uk = { ...(ukEntry ? { entry_city: ukEntry } : {}), ...(ukEnd ? { end_city: ukEnd } : {}) };
      const adjEntry = text('adjusted_entry_city');
      const adjExit = text('adjusted_exit_city');
      const section = numberOption(interaction, 'section');
      if (adjEntry || adjExit) {
        if (section === undefined) problems.push('Give `section` (the number /review shows) with the adjusted-scale cities.');
        else changes.adjusted_scales = { [String(section - 1)]: { ...(adjEntry ? { entry_city: adjEntry } : {}), ...(adjExit ? { exit_city: adjExit } : {}) } };
      } else if (section !== undefined) problems.push('`section` goes with `adjusted_entry_city` or `adjusted_exit_city`.');
    } else if (sub === 'clear') {
      for (const name of (stringOption(interaction, 'fields') ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
        const field = CLEARABLE[name];
        const section = CLEAR_SECTION.exec(name);
        if (field) (changes as Record<string, null>)[field] = null;
        else if (section && Number(section[1]) >= 1 && Number(section[1]) <= MAX_ADJUSTED_SECTIONS) {
          // Numbers refer to the list before this edit, so several can be removed at once.
          // Clearing them all (adjusted_scales) wins over single ones.
          if (changes.adjusted_scales !== null) changes.adjusted_scales = { ...changes.adjusted_scales, [String(Number(section[1]) - 1)]: null };
        } else problems.push(`\`${name}\` can’t be cleared. These can: ${CLEAR_HELP}.`);
      }
    }
    if (problems.length === 0 && Object.keys(changes).filter((k) => k !== 'unit' && k !== 'fuel_unit').length === 0) problems.push('Give at least one field to change.');
    if (problems.length > 0) return { kind: 'reply', ephemeral: true, message: { content: problems.map((p) => `• ${p}`).join('\n').slice(0, 2000) } };
    return { kind: 'defer', ephemeral: true, task: { name: EDIT_JOB_TASK, input: { jobId, reason, changes } } };
  },
};

export const editJobTask: TaskDefinition = {
  name: EDIT_JOB_TASK,
  async run(input, { interaction, deps }) {
    const { jobId, reason, changes } = input as { jobId: string; reason: string; changes: JobEdit };
    const admin = adminFor(deps, interaction);
    const id = formatJobId(jobId);
    const result = await admin.editJob(jobId, changes, { reason, idempotencyKey: idempotencyKey(interaction.id, 'job.edit') }).catch((err: unknown) => {
      throw modFailure(err, `No job with ID ${id}.`);
    });
    const overrides = Object.entries(result.overrides).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${brief(v, 60)}`);
    return {
      message: privateMessage({
        content: [
          `Edited job **${id}**: ${describeChanges(changes).join('; ')}.`,
          `Now ${OUTCOME_LABELS[result.outcome]}, ${pointsText(result.outcome, result.points, result.held_points)} points.`,
          overrides.length > 0 ? `All edits on this job: ${overrides.join('; ')}` : 'No edits remain on this job (every field is back to its recorded or submitted value).',
        ]
          .join('\n')
          .slice(0, 2000),
      }),
    };
  },
};
