import type { APIActionRowComponent, APIComponentInMessageActionRow, APIEmbed, APIEmbedField } from 'discord-api-types/v10';
import { ApiError, idempotencyKey } from '../../api/client.ts';
import { formatJobId, parseJobId } from '../../api/ids.ts';
import { toRouteRenderRequest } from '../../api/route.ts';
import type { AdminJobDetail, Decision, Outcome, ReviewQueueItem, Series, ServerRoute } from '../../api/schemas.ts';
import { MAP_CREDIT_LINE } from '../../credits.ts';
import { ApplicationCommandOptionType, ButtonStyle, ComponentType } from '../../discord/constants.ts';
import type { OutgoingFile } from '../../discord/rest.ts';
import type { CommandDefinition, ComponentDefinition, ModalDefinition, TaskDefinition, TaskDeps } from '../../interactions/types.ts';
import { discordTime, distance, escapeMarkdown, GAME_SHORT, isGame, OUTCOME_LABELS, pointsText } from '../format.ts';
import { stringOption, subcommand } from '../options.ts';
import { evidenceImages } from '../submit.ts';
import { jobCharts } from '../charts.ts';
import { adminFor, brief, modalValue, modFailure, privateMessage, reasonModal } from './common.ts';

// /review queue | job | trace, plus the job view's buttons. Decisions go
// through a reason form (a button can't carry text) and send the job's etag,
// so a decision made from a stale view fails instead of overwriting another
// moderator's (ADMIN_API §4, §7).

export const REVIEW_QUEUE_TASK = 'mod.review.queue';
export const REVIEW_JOB_TASK = 'mod.review.job';
export const REVIEW_TRACE_TASK = 'mod.review.trace';
export const DECIDE_TASK = 'mod.decide';
export const RECALC_JOB_TASK = 'mod.recalc.job';

const PAGE = 10;
const CURSOR = /^[\x21-\x7e]{1,64}$/;
/** Server ADMIN_API §6: the bot may attach a trace up to 10 MiB. */
const TRACE_ATTACH_MAX = 10 * 1024 * 1024;

/** Contract ADMIN_API §7: which decisions each outcome allows. */
export const ALLOWED_DECISIONS: Record<Decision, readonly Outcome[]> = {
  approve: ['pending_review', 'invalid', 'rejected'],
  reject: ['pending_review', 'valid', 'approved', 'invalid'],
  void: ['valid', 'approved', 'pending_review', 'invalid', 'rejected'],
  restore: ['voided'],
};

const DECISION_LABELS: Record<Decision, string> = { approve: 'Approve', reject: 'Reject', void: 'Void', restore: 'Restore' };
const DECISION_DONE: Record<Decision, string> = { approve: 'Approved', reject: 'Rejected', void: 'Voided', restore: 'Restored' };
const DECISION_STYLE: Record<Decision, number> = {
  approve: ButtonStyle.Success,
  reject: ButtonStyle.Danger,
  void: ButtonStyle.Secondary,
  restore: ButtonStyle.Secondary,
};

const jobIdOption = { type: ApplicationCommandOptionType.String, name: 'id', description: 'Job ID, like 7K2M-9QXA', required: true, min_length: 8, max_length: 12 } as const;

export const reviewCommand: CommandDefinition = {
  access: 'moderator',
  json: {
    name: 'review',
    description: 'Review queue and job details (moderators; only you see the replies)',
    options: [
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'queue',
        description: 'Jobs waiting for review, oldest first',
        options: [
          {
            type: ApplicationCommandOptionType.String,
            name: 'game',
            description: 'Default: both games',
            required: false,
            choices: [
              { name: 'Euro Truck Simulator 2', value: 'ets2' },
              { name: 'American Truck Simulator', value: 'ats' },
            ],
          },
          {
            type: ApplicationCommandOptionType.String,
            name: 'outcome',
            description: 'Default: both',
            required: false,
            choices: [
              { name: 'In review', value: 'pending_review' },
              { name: 'Invalid', value: 'invalid' },
            ],
          },
          { type: ApplicationCommandOptionType.String, name: 'reason', description: 'A review reason code, e.g. late_start', required: false, max_length: 24 },
        ],
      },
      { type: ApplicationCommandOptionType.Subcommand, name: 'job', description: 'Everything about one job, with actions', options: [jobIdOption] },
      { type: ApplicationCommandOptionType.Subcommand, name: 'trace', description: 'The job’s full raw trace', options: [jobIdOption] },
    ],
  },
  handle: ({ interaction }) => {
    const sub = subcommand(interaction);
    if (sub === 'queue') {
      const game = stringOption(interaction, 'game');
      const outcome = stringOption(interaction, 'outcome');
      const reason = stringOption(interaction, 'reason')?.trim().toLowerCase();
      if (reason && !/^[a-z_]{1,24}$/.test(reason)) {
        return { kind: 'reply', ephemeral: true, message: { content: 'Reason codes look like `late_start`.' } };
      }
      const input: QueueInput = { game: isGame(game) ? game : null, outcome: outcome ?? null, reason: reason ?? null, cursor: null };
      return { kind: 'defer', ephemeral: true, task: { name: REVIEW_QUEUE_TASK, input } };
    }
    const jobId = parseJobId(stringOption(interaction, 'id') ?? '');
    if (!jobId) return { kind: 'reply', ephemeral: true, message: { content: 'That isn’t a job ID. Job IDs look like `7K2M-9QXA`.' } };
    return { kind: 'defer', ephemeral: true, task: { name: sub === 'trace' ? REVIEW_TRACE_TASK : REVIEW_JOB_TASK, input: { jobId } } };
  },
};

// ---------------------------------------------------------------------------
// Queue

interface QueueInput {
  game: 'ets2' | 'ats' | null;
  outcome: string | null;
  reason: string | null;
  cursor: string | null;
}

export const reviewQueueTask: TaskDefinition = {
  name: REVIEW_QUEUE_TASK,
  async run(input, { interaction, deps }) {
    const q = input as QueueInput;
    const page = await adminFor(deps, interaction)
      .reviewQueue({
        limit: PAGE,
        cursor: q.cursor,
        ...(q.game ? { game: q.game } : {}),
        ...(q.outcome ? { outcome: [q.outcome] } : {}),
        ...(q.reason ? { reason: q.reason } : {}),
      })
      .catch((err: unknown) => {
        throw modFailure(err);
      });
    const embed: APIEmbed = {
      title: `Review queue${page.total !== undefined ? ` (${page.total})` : ''}`,
      description: page.items.length > 0 ? page.items.map(queueLine).join('\n') : 'Nothing waiting. 🎉',
      footer: { text: 'Oldest first. Pick a job below to open it.' },
    };
    const rows: APIActionRowComponent<APIComponentInMessageActionRow>[] = [];
    if (page.items.length > 0) {
      rows.push({
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.StringSelect,
            custom_id: 'mjob-pick',
            placeholder: 'Open a job…',
            options: page.items.slice(0, 25).map((j) => ({
              label: `${formatJobId(j.job_id)} · ${GAME_SHORT[j.game]} · ${OUTCOME_LABELS[j.outcome]}`,
              description: `${j.player.display_name} · ${j.reasons.map((r) => r.code).join(', ')}`.slice(0, 100),
              value: j.job_id,
            })),
          },
        ],
      });
    }
    const base = `rq:${q.game ?? '-'}:${q.outcome === 'pending_review' ? 'p' : q.outcome === 'invalid' ? 'i' : '-'}:${q.reason ?? '-'}`;
    const pager: APIComponentInMessageActionRow[] = [];
    if (q.cursor) pager.push({ type: ComponentType.Button, style: ButtonStyle.Secondary, custom_id: `${base}:`, label: 'First page' });
    if (page.next_cursor && CURSOR.test(page.next_cursor) && `${base}:${page.next_cursor}`.length <= 100) {
      pager.push({ type: ComponentType.Button, style: ButtonStyle.Primary, custom_id: `${base}:${page.next_cursor}`, label: 'Next' });
    }
    if (pager.length > 0) rows.push({ type: ComponentType.ActionRow, components: pager });
    return { message: privateMessage({ embeds: [embed], components: rows }) };
  },
};

function queueLine(j: ReviewQueueItem): string {
  const held = j.held_points !== null && j.held_points !== undefined ? ` · ${j.held_points} held` : '';
  const age = j.age_s !== undefined ? ` · ${Math.round(j.age_s / 3600)} h old` : '';
  return `\`${formatJobId(j.job_id)}\` ${GAME_SHORT[j.game]} · ${OUTCOME_LABELS[j.outcome]}${held} · ${escapeMarkdown(j.player.display_name)} · ${j.reasons.map((r) => r.code).join(', ') || '—'}${age}`;
}

// ---------------------------------------------------------------------------
// Job view

export const reviewJobTask: TaskDefinition = {
  name: REVIEW_JOB_TASK,
  async run(input, { interaction, deps }) {
    const { jobId } = input as { jobId: string };
    const admin = adminFor(deps, interaction);
    const notFound = `No job with ID ${formatJobId(jobId)}.`;
    const [job, series, route] = await Promise.all([
      admin.job(jobId).catch((err: unknown) => {
        throw modFailure(err, notFound);
      }),
      admin.series(jobId, 1000).catch((err: unknown) => optional(err, deps, 'series')),
      admin.route(jobId).catch((err: unknown) => optional(err, deps, 'route')),
    ]);
    return { ...(await jobView(job, series, route, deps)) };
  },
};

/** Series and route are extras: the view still works without them. */
function optional(err: unknown, deps: TaskDeps, what: string): null {
  if (err instanceof ApiError && (err.status === 404 || err.retryable)) return null;
  deps.logger.warn(`admin ${what} unavailable`, { err });
  return null;
}

async function jobView(job: AdminJobDetail, series: Series | null, route: ServerRoute | null, deps: TaskDeps) {
  const title = `Job ${formatJobId(job.job_id)}`;
  const [map, charts] = await Promise.all([
    route && route.features.length > 0 ? image(deps, () => deps.renderer.renderRoute(toRouteRenderRequest(route, { title }))) : null,
    // Speed, fuel, distance (in game and 1:1) and damage over the job's time.
    series ? jobCharts(series, title, deps) : [],
  ]);

  const files: OutgoingFile[] = [];
  const main = jobEmbed(job);
  const embeds: APIEmbed[] = [main];
  if (map) {
    files.push({ name: 'route.png', bytes: map, contentType: 'image/png', description: `${title} route, with undone stretches` });
    main.image = { url: 'attachment://route.png' };
    main.footer = { text: MAP_CREDIT_LINE };
  }
  for (const chart of charts) {
    files.push({ name: chart.name, bytes: chart.bytes, contentType: 'image/png' });
    embeds.push({ title: chart.title, image: { url: `attachment://${chart.name}` } });
  }
  if (!map && charts.length === 0 && (route || series)) main.footer = { text: 'Maps and charts aren’t available right now.' };
  // Images of a manual job (custom map, evidence), fetched now: the links last an hour.
  if (job.evidence.length > 0) {
    const shown = await evidenceImages(job.evidence, deps, 10 - embeds.length);
    embeds.push(...shown.embeds);
    files.push(...shown.files);
    if (shown.missing > 0) main.footer = { text: `${shown.missing} evidence image(s) couldn’t be shown.` };
  }
  return { message: privateMessage({ embeds, components: jobButtons(job) }), files };
}

async function image(deps: TaskDeps, render: () => Promise<{ bytes: Uint8Array<ArrayBuffer> } | null>): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    return (await render())?.bytes ?? null;
  } catch (err) {
    deps.logger.warn('moderator image unavailable', { err });
    return null;
  }
}

export function jobEmbed(job: AdminJobDetail): APIEmbed {
  const fields: APIEmbedField[] = [
    { name: 'Outcome', value: OUTCOME_LABELS[job.outcome], inline: true },
    { name: 'Points', value: pointsText(job.outcome, job.points, job.held_points), inline: true },
    { name: 'Player', value: `${escapeMarkdown(job.player.display_name)} (<@${job.player.discord_user_id}>)`, inline: true },
    { name: 'Driven (1:1)', value: distance(job.world_mi, job.world_km), inline: true },
    { name: 'In game', value: distance(job.game_mi, job.game_km), inline: true },
    {
      name: 'Delivered',
      value: `${discordTime(job.delivered_at, 'f')}${job.reported_delivered_at ? `\nplayer’s PC: ${discordTime(job.reported_delivered_at, 'f')}` : ''}`,
      inline: true,
    },
  ];
  if (job.reasons.length > 0) {
    fields.push({
      name: 'Review reasons',
      value: job.reasons
        .map((r) => `• \`${r.code}\`${r.text ? ` ${escapeMarkdown(r.text)}` : ''}${r.details && Object.keys(r.details).length > 0 ? ` (${brief(r.details, 120)})` : ''}`)
        .join('\n')
        .slice(0, 1024),
    });
  }
  const speed = job.speed ?? {};
  const speedText = [
    num(speed['peak_mph']) !== null ? `peak ${num(speed['peak_mph'])} mph` : null,
    num(speed['over_penalty_s']) ? `${num(speed['over_penalty_s'])} s over ${num(speed['penalty_over_mph']) ?? '?'} mph` : null,
    num(speed['over_invalid_s']) ? `${num(speed['over_invalid_s'])} s over ${num(speed['invalid_over_mph']) ?? '?'} mph` : null,
  ].filter(Boolean);
  if (speedText.length > 0) fields.push({ name: 'Speed', value: speedText.join(' · '), inline: true });
  const fuel = job.fuel ?? {};
  if (num(fuel['used_l']) !== null) {
    const refuels = Array.isArray(fuel['refuels']) ? fuel['refuels'].length : 0;
    fields.push({ name: 'Fuel', value: `${num(fuel['used_l'])} L used${refuels ? ` · ${refuels} refuel${refuels === 1 ? '' : 's'}` : ''}`, inline: true });
  }
  const integrity = job.integrity ?? {};
  const failedChecks = Array.isArray(integrity['trace_checks'])
    ? (integrity['trace_checks'] as { check?: unknown; ok?: unknown }[]).filter((c) => c.ok === false).map((c) => String(c.check))
    : [];
  const integrityText = [
    integrity['config_matched_version'] !== undefined ? `config: ${brief(integrity['config_matched_version'] ?? 'no match', 30)}` : null,
    integrity['manifest_result'] !== undefined ? `install: ${brief(integrity['manifest_result'], 30)}` : null,
    failedChecks.length > 0 ? `failed checks: ${failedChecks.join(', ')}` : null,
  ].filter(Boolean);
  if (integrityText.length > 0) fields.push({ name: 'Integrity', value: integrityText.join('\n').slice(0, 1024), inline: true });
  if (job.origin === 'manual') fields.push(...manualFields(job));
  const edits = Object.entries(job.overrides);
  if (edits.length > 0) {
    fields.push({ name: 'Edited by moderators', value: edits.map(([k, v]) => `${k.replace(/_/g, ' ')}: ${brief(v, 60)}`).join('\n').slice(0, 1024) });
  }
  const triggered = (job.rules ?? []).filter((r) => r.triggered).map((r) => `\`${r.rule}\``);
  if (triggered.length > 0) fields.push({ name: 'Rules triggered', value: triggered.join(', ').slice(0, 1024), inline: true });
  const reverted = (job.segments ?? []).filter((s) => s.status === 'reverted').length;
  if (reverted > 0) fields.push({ name: 'Undone by save loads', value: `${reverted} stretch${reverted === 1 ? '' : 'es'} (faded on the map)`, inline: true });
  const timeline = (job.timeline ?? []).slice(0, 12).map((t) => `${discordTime(t.at, 'R')} ${t.event.replace(/_/g, ' ')}`);
  if (timeline.length > 0) {
    fields.push({ name: `Timeline${(job.timeline?.length ?? 0) > 12 ? ' (first 12)' : ''}`, value: timeline.join('\n').slice(0, 1024) });
  }
  return {
    title: `Job ${formatJobId(job.job_id)} · ${GAME_SHORT[job.game]} · ${OUTCOME_LABELS[job.outcome]}`,
    description: `**${escapeMarkdown(job.cargo.name)}**: ${escapeMarkdown(job.source.city_name)} → ${escapeMarkdown(job.destination.city_name)}`,
    fields: fields.slice(0, 25),
  };
}

/** The submitted stats (the server's sheet: km with miles beside, litres). */
function manualFields(job: AdminJobDetail): APIEmbedField[] {
  const s = job.sheet;
  const fields: APIEmbedField[] = [];
  const units = job.submission ? ` (typed in ${job.submission.unit}, ${job.submission.fuel_unit.replace('_', ' ')})` : '';
  if (s) {
    const lines = [
      s.distance_km !== undefined && s.distance_km !== null ? `Distance (game): ${distance(s.distance_mi, s.distance_km)}` : null,
      s.map_scale ? `Map scale: 1:${s.map_scale}${job.submission?.map_scale_defaulted ? ' (default)' : ''}` : null,
      s.uk ? `UK (1:15): ${distance(s.uk.distance_mi, s.uk.distance_km)}, ${escapeMarkdown(s.uk.entry_city ?? '?')} → ${escapeMarkdown(s.uk.end_city ?? '?')}` : null,
      // Numbered from 1; /approve-manual and /edit-job take these numbers.
      ...(s.adjusted_scales ?? []).map(
        (a, n) =>
          `Section ${n + 1} (1:${a.scale ?? '?'}): ${distance(a.distance_mi, a.distance_km)}, ${escapeMarkdown(a.entry_city ?? '?')} → ${escapeMarkdown(a.exit_city ?? '?')}`,
      ),
      s.fuel_used_l !== undefined && s.fuel_used_l !== null ? `Fuel: ${s.fuel_used_l} L` : null,
      s.damage_pct !== undefined && s.damage_pct !== null ? `Damage: ${s.damage_pct}%` : null,
      s.profit !== undefined && s.profit !== null ? `Profit: ${s.profit}` : null,
      s.truck ? `Truck: ${escapeMarkdown(`${s.truck}${s.truck_model ? ` ${s.truck_model}` : ''}`)}` : null,
      s.started_at ? `Started ${discordTime(s.started_at, 'f')}${s.ended_at ? `, delivered ${discordTime(s.ended_at, 'f')}` : ''}` : null,
      s.mods && s.mods.length > 0 ? `Mods: ${s.mods.map(escapeMarkdown).join(', ')}` : null,
    ].filter(Boolean);
    fields.push({ name: `Submitted by hand${units}`, value: (lines.join('\n') || '—').slice(0, 1024) });
  }
  if (job.custom_map) fields.push({ name: 'Custom map', value: job.hide_map ? 'Hidden from the public view' : 'Public in /job', inline: true });
  return fields;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Only the decisions the contract allows from the job's current outcome. */
export function jobButtons(job: Pick<AdminJobDetail, 'job_id' | 'outcome' | 'etag'>): APIActionRowComponent<APIComponentInMessageActionRow>[] {
  const decisions = (Object.keys(ALLOWED_DECISIONS) as Decision[]).filter((d) => ALLOWED_DECISIONS[d].includes(job.outcome));
  const decide = decisions.map((d) => ({
    type: ComponentType.Button,
    style: DECISION_STYLE[d],
    label: DECISION_LABELS[d],
    custom_id: `mdec:${d}:${job.job_id}:${job.etag}`.slice(0, 100),
  })) as APIComponentInMessageActionRow[];
  const tools: APIComponentInMessageActionRow[] = [
    { type: ComponentType.Button, style: ButtonStyle.Secondary, label: 'Recalculate', custom_id: `mrec:${job.job_id}` },
    { type: ComponentType.Button, style: ButtonStyle.Secondary, label: 'Trace', custom_id: `mtrace:${job.job_id}` },
    { type: ComponentType.Button, style: ButtonStyle.Secondary, label: 'Refresh', custom_id: `mjob:${job.job_id}` },
  ];
  return [
    ...(decide.length > 0 ? [{ type: ComponentType.ActionRow, components: decide } as APIActionRowComponent<APIComponentInMessageActionRow>] : []),
    { type: ComponentType.ActionRow, components: tools },
  ];
}

// ---------------------------------------------------------------------------
// Buttons, select and forms

const DECISIONS = ['approve', 'reject', 'void', 'restore'] as const;

export const reviewComponents: ComponentDefinition[] = [
  {
    // "Open" on review-channel posts, and "Refresh" on the job view: a new private view.
    prefix: 'mjob',
    access: 'moderator',
    handle: (_ctx, arg) => {
      const jobId = parseJobId(arg);
      return jobId
        ? { kind: 'defer', ephemeral: true, task: { name: REVIEW_JOB_TASK, input: { jobId } } }
        : { kind: 'reply', ephemeral: true, message: { content: 'That button is broken. Use `/review job`.' } };
    },
  },
  {
    prefix: 'mjob-pick',
    access: 'moderator',
    handle: ({ interaction }) => {
      const values = (interaction.data as { values?: string[] }).values ?? [];
      const jobId = parseJobId(values[0] ?? '');
      return jobId
        ? { kind: 'defer', ephemeral: true, task: { name: REVIEW_JOB_TASK, input: { jobId } } }
        : { kind: 'reply', ephemeral: true, message: { content: 'Pick a job from the list.' } };
    },
  },
  {
    prefix: 'rq',
    access: 'moderator',
    handle: (_ctx, arg) => {
      const [g, o, reason, ...rest] = arg.split(':');
      const cursor = rest.join(':');
      if ((g !== '-' && !isGame(g)) || !['p', 'i', '-'].includes(o ?? '') || !/^([a-z_]{1,24}|-)$/.test(reason ?? '') || (cursor !== '' && !CURSOR.test(cursor))) {
        return { kind: 'update', message: { content: 'This list has expired. Run `/review queue` again.', embeds: [], components: [] } };
      }
      const input: QueueInput = {
        game: isGame(g) ? g : null,
        outcome: o === 'p' ? 'pending_review' : o === 'i' ? 'invalid' : null,
        reason: reason === '-' ? null : reason!,
        cursor: cursor || null,
      };
      return { kind: 'defer-update', task: { name: REVIEW_QUEUE_TASK, input } };
    },
  },
  {
    // A decision button opens the reason form; the form carries the etag on.
    prefix: 'mdec',
    access: 'moderator',
    handle: (_ctx, arg) => {
      const [decision, jobId, ...etagParts] = arg.split(':');
      if (!DECISIONS.includes(decision as Decision) || !parseJobId(jobId ?? '')) {
        return { kind: 'reply', ephemeral: true, message: { content: 'That button is broken. Use `/review job`.' } };
      }
      const label = DECISION_LABELS[decision as Decision];
      return { kind: 'modal', modal: reasonModal(`mdec:${decision}:${jobId}:${etagParts.join(':')}`.slice(0, 100), `${label} job ${formatJobId(jobId!)}`) };
    },
  },
  {
    prefix: 'mrec',
    access: 'moderator',
    handle: (_ctx, arg) => {
      const jobId = parseJobId(arg);
      return jobId
        ? { kind: 'modal', modal: reasonModal(`mrec:${jobId}`, `Recalculate job ${formatJobId(jobId)}`) }
        : { kind: 'reply', ephemeral: true, message: { content: 'That button is broken.' } };
    },
  },
  {
    prefix: 'mtrace',
    access: 'moderator',
    handle: (_ctx, arg) => {
      const jobId = parseJobId(arg);
      return jobId
        ? { kind: 'defer', ephemeral: true, task: { name: REVIEW_TRACE_TASK, input: { jobId } } }
        : { kind: 'reply', ephemeral: true, message: { content: 'That button is broken.' } };
    },
  },
];

export const reviewModals: ModalDefinition[] = [
  {
    prefix: 'mdec',
    access: 'moderator',
    handle: ({ interaction }, arg) => {
      const [decision, jobId, ...etagParts] = arg.split(':');
      const reason = modalValue(interaction, 'reason') ?? '';
      const etag = etagParts.join(':');
      const input: DecideInput = { decision: decision as Decision, jobId: jobId ?? '', etag: etag || null, reason };
      return { kind: 'defer', ephemeral: true, task: { name: DECIDE_TASK, input } };
    },
  },
  {
    prefix: 'mrec',
    access: 'moderator',
    handle: ({ interaction }, arg) => ({
      kind: 'defer',
      ephemeral: true,
      task: { name: RECALC_JOB_TASK, input: { jobId: arg, reason: modalValue(interaction, 'reason') ?? '' } },
    }),
  },
];

interface DecideInput {
  decision: Decision;
  jobId: string;
  etag: string | null;
  reason: string;
}

export const decideTask: TaskDefinition = {
  name: DECIDE_TASK,
  async run(input, { interaction, deps }) {
    const { decision, jobId, etag, reason } = input as DecideInput;
    if (!DECISIONS.includes(decision) || !parseJobId(jobId)) throw new Error('malformed decision input');
    try {
      const res = await adminFor(deps, interaction).decide(jobId, decision, {
        reason,
        idempotencyKey: idempotencyKey(interaction.id, `decide.${decision}`),
        ...(etag ? { expectedEtag: etag } : {}),
      });
      const points = res.points !== null ? ` Points: **${res.points}**.` : '';
      return {
        message: privateMessage({
          content: `${DECISION_DONE[decision]} job ${formatJobId(res.job_id)}. It is now **${OUTCOME_LABELS[res.outcome]}**.${points}`,
          components: [],
        }),
      };
    } catch (err) {
      if (err instanceof ApiError && err.code === 'conflict') {
        return {
          message: privateMessage({
            content: `Another moderator changed job ${formatJobId(jobId)} since you opened it. Nothing was done; look again first.`,
            components: [{ type: ComponentType.ActionRow, components: [{ type: ComponentType.Button, style: ButtonStyle.Primary, label: 'Open it again', custom_id: `mjob:${jobId}` }] }],
          }),
        };
      }
      throw modFailure(err, `No job with ID ${formatJobId(jobId)}.`);
    }
  },
};

export const recalcJobTask: TaskDefinition = {
  name: RECALC_JOB_TASK,
  async run(input, { interaction, deps }) {
    const { jobId, reason } = input as { jobId: string; reason: string };
    const id = parseJobId(jobId);
    if (!id) throw new Error('malformed recalculation input');
    const res = await adminFor(deps, interaction)
      .recalculateJob(id, { reason, idempotencyKey: idempotencyKey(interaction.id, 'recalc.job') })
      .catch((err: unknown) => {
        throw modFailure(err, `No job with ID ${formatJobId(id)}.`);
      });
    const before = `${OUTCOME_LABELS[res.before.outcome]}, ${pointsText(res.before.outcome, res.before.points, res.before.held_points)}`;
    const after = `${OUTCOME_LABELS[res.after.outcome]}, ${pointsText(res.after.outcome, res.after.points, res.after.held_points)}`;
    return {
      message: privateMessage({
        content: before === after ? `Recalculated job ${formatJobId(id)}: unchanged (${after}).` : `Recalculated job ${formatJobId(id)}: ${before} → **${after}**.`,
      }),
    };
  },
};

// ---------------------------------------------------------------------------
// Trace

export const reviewTraceTask: TaskDefinition = {
  name: REVIEW_TRACE_TASK,
  async run(input, { interaction, deps }) {
    const { jobId } = input as { jobId: string };
    const link = await adminFor(deps, interaction)
      .trace(jobId)
      .catch((err: unknown) => {
        throw modFailure(err, `No job with ID ${formatJobId(jobId)}.`);
      });
    const name = `trace-${formatJobId(jobId)}.jsonl.gz`;
    const summary = `Full trace of job ${formatJobId(jobId)}: ${link.frames ?? '?'} frames, ${(link.size_bytes / 1024 / 1024).toFixed(1)} MiB (${link.format}).`;
    if (link.size_bytes <= TRACE_ATTACH_MAX) {
      try {
        const res = await fetch(link.url);
        if (res.ok) {
          const bytes = new Uint8Array(await res.arrayBuffer());
          if (bytes.length <= TRACE_ATTACH_MAX) {
            return { message: privateMessage({ content: summary }), files: [{ name, bytes, contentType: 'application/gzip' }] };
          }
        }
      } catch (err) {
        // The link below still works. Never log the URL: it is a credential for 15 minutes.
        deps.logger.warn('trace download failed; sending the link instead', { jobId, err: err instanceof Error ? err.name : 'error' });
      }
    }
    return {
      message: privateMessage({
        content: `${summary}\nDownload (only you can see this; the link works until ${discordTime(link.expires_at, 'T')}): <${link.url}>`,
      }),
    };
  },
};

export const reviewTasks = [reviewQueueTask, reviewJobTask, reviewTraceTask, decideTask, recalcJobTask];
