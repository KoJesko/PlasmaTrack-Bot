import type { APIEmbed, APIEmbedField } from 'discord-api-types/v10';
import { ApiError } from '../api/client.ts';
import { apiFailure, requireApi } from '../api/errors.ts';
import { formatJobId, parseJobId } from '../api/ids.ts';
import { toRouteRenderRequest } from '../api/route.ts';
import type { JobDetail, ServerRoute } from '../api/schemas.ts';
import { MAP_CREDIT_LINE } from '../credits.ts';
import { ApplicationCommandOptionType, MessageFlags } from '../discord/constants.ts';
import type { OutgoingFile } from '../discord/rest.ts';
import type { CommandDefinition, TaskDefinition, TaskDeps } from '../interactions/types.ts';
import { SCALE_CLASS_LABELS, SCALE_CLASSES } from '../render/protocol.ts';
import { discordTime, distance, escapeMarkdown, GAME_SHORT, multiplayerLabel, OUTCOME_LABELS, pointsText } from './format.ts';
import { MAX_EVIDENCE_BYTES, money } from './manual-fields.ts';
import { booleanOption, PRIVATE_OPTION, stringOption } from './options.ts';
import { evidenceButton } from './submit.ts';
import { sniffImageType } from '../media.ts';

export const JOB_TASK = 'job.show';

const OUTCOME_COLORS: Record<string, number> = {
  valid: 0x2e9e5b,
  approved: 0x2e9e5b,
  pending_review: 0xf2a33a,
  invalid: 0xd62828,
  rejected: 0xd62828,
  discarded: 0x6b6b6b,
  voided: 0x6b6b6b,
};

interface JobInput {
  jobId: string;
  private: boolean;
}

export const jobCommand: CommandDefinition = {
  access: 'member',
  json: {
    name: 'job',
    description: 'A job’s details and route map',
    options: [
      { type: ApplicationCommandOptionType.String, name: 'id', description: 'Job ID, like 7K2M-9QXA', required: true, min_length: 8, max_length: 12 },
      PRIVATE_OPTION,
    ],
  },
  handle: ({ interaction }) => {
    const jobId = parseJobId(stringOption(interaction, 'id') ?? '');
    if (!jobId) {
      return { kind: 'reply', ephemeral: true, message: { content: 'That isn’t a job ID. Job IDs look like `7K2M-9QXA`.' } };
    }
    const priv = booleanOption(interaction, 'private') ?? false;
    const input: JobInput = { jobId, private: priv };
    return { kind: 'defer', ephemeral: priv, task: { name: JOB_TASK, input } };
  },
};

export const jobTask: TaskDefinition = {
  name: JOB_TASK,
  async run(input, { deps }) {
    const { jobId, private: priv } = input as JobInput;
    const api = requireApi(deps);
    const notFound = `No job with ID ${formatJobId(jobId)}.`;
    const [job, route] = await Promise.all([
      api.getJob(jobId).catch((err: unknown) => {
        throw apiFailure(err, { notFound });
      }),
      api.getRoute(jobId).catch((err: unknown) => {
        // A job without a route (e.g. discarded), or a server that can't draw
        // routes yet (501), still shows its details.
        if (err instanceof ApiError && (err.status === 404 || err.status === 501)) return null;
        throw apiFailure(err, { notFound });
      }),
    ]);

    const embed = jobEmbed(job);
    const files: OutgoingFile[] = [];
    const map = route ? await routeImage(job, route, deps) : null;
    if (map) {
      files.push({ name: 'route.png', bytes: map, contentType: 'image/png', description: `Route of job ${formatJobId(job.job_id)}` });
      embed.image = { url: 'attachment://route.png' };
      embed.footer = { text: MAP_CREDIT_LINE };
    } else if (route && route.features.length > 0) {
      embed.footer = { text: 'The route map isn’t available right now.' };
    }
    // A manual job has no route; its custom map (if not hidden) is public.
    const custom = job.custom_map ? await customMapImage(job, deps) : null;
    if (custom) {
      files.push(custom);
      embed.image = { url: `attachment://${custom.name}` };
      embed.footer = { text: 'Custom map submitted by the player' };
    }
    const manual = job.origin === 'manual';
    return {
      message: { embeds: [embed], flags: priv ? MessageFlags.Ephemeral : 0, ...(manual ? { components: [evidenceButton(job.job_id)] } : {}) },
      files,
    };
  },
};

export function jobEmbed(job: JobDetail): APIEmbed {
  const from = place(job.source);
  const to = place(job.destination);
  const fields: APIEmbedField[] = [
    { name: 'Outcome', value: OUTCOME_LABELS[job.outcome], inline: true },
    { name: 'Points', value: pointsText(job.outcome, job.points, job.held_points), inline: true },
    { name: 'Player', value: `${escapeMarkdown(job.player.display_name)} (<@${job.player.discord_user_id}>)`, inline: true },
    { name: 'Driven (1:1)', value: distance(job.world_mi, job.world_km), inline: true },
    { name: 'In game', value: distance(job.game_mi, job.game_km), inline: true },
    { name: 'Delivered', value: discordTime(job.delivered_at, 'f'), inline: true },
  ];
  const mode = multiplayerLabel(job.multiplayer);
  if (mode) fields.push({ name: 'Played', value: mode, inline: true });
  if (job.bonus) {
    const amount = job.bonus.kind === 'multiplier' ? `×${job.bonus.amount}` : `+${job.bonus.amount} points`;
    fields.push({ name: 'Bonus', value: `${escapeMarkdown(job.bonus.label)} (${amount})`, inline: true });
  }
  if (job.speed_penalty_applied) fields.push({ name: 'Speed penalty', value: '0.85× distance', inline: true });
  // Public since server 69fcfe9; null when unknown.
  if (typeof job.fuel_used_l === 'number') {
    const gal = Math.round((job.fuel_used_l / 3.785411784) * 100) / 100;
    fields.push({ name: 'Fuel used', value: job.game === 'ats' ? `${gal} gal (${job.fuel_used_l} L)` : `${job.fuel_used_l} L`, inline: true });
  } else if (job.fuel_readable === false) {
    // Server PR #6: readings beyond any tank (a save edit); the fuel burned can't be told.
    fields.push({ name: 'Fuel used', value: 'not readable', inline: true });
  }
  if (typeof job.damage_pct === 'number') fields.push({ name: 'Cargo damage', value: `${job.damage_pct}%`, inline: true });
  if (typeof job.income === 'number') fields.push({ name: 'Income', value: money(job.income, job.game), inline: true });

  const scale = scaleBreakdown(job);
  if (scale) fields.push({ name: 'Distance by map scale', value: scale });
  if (job.public_notes.length > 0) {
    fields.push({ name: 'Notes', value: job.public_notes.map((n) => `• ${escapeMarkdown(n.text)}`).join('\n').slice(0, 1024) });
  }
  return {
    title: `Job ${formatJobId(job.job_id)} · ${GAME_SHORT[job.game]}`,
    description: `**${escapeMarkdown(job.cargo.name)}**: ${from} → ${to}${job.origin === 'manual' ? '\nSubmitted by hand' : ''}`,
    ...(OUTCOME_COLORS[job.outcome] !== undefined ? { color: OUTCOME_COLORS[job.outcome] } : {}),
    fields,
  };
}

function place(p: JobDetail['source']): string {
  const city = escapeMarkdown(p.city_name);
  return p.company_name ? `${city} (${escapeMarkdown(p.company_name)})` : city;
}

/** The counted distance per scale class (both units since the 2026-10-14 contract change). */
function scaleBreakdown(job: JobDetail): string | null {
  const byClass = job.distance_by_scale_class;
  if (!byClass) return null;
  const lines: string[] = [];
  for (const c of SCALE_CLASSES) {
    const d = byClass[c];
    if (!d || (d.world_km === 0 && d.game_km === 0)) continue;
    lines.push(`${SCALE_CLASS_LABELS[c]}: ${distance(d.world_mi, d.world_km)} driven, ${distance(d.game_mi, d.game_km)} in game`);
  }
  return lines.length > 0 ? lines.join('\n') : null;
}

/** The signed link is valid for an hour, so the image is fetched and attached now. Best effort. */
async function customMapImage(job: JobDetail, deps: TaskDeps): Promise<OutgoingFile | null> {
  try {
    const got = await deps.media.get(job.custom_map!.url, MAX_EVIDENCE_BYTES);
    const type = sniffImageType(got.bytes);
    if (!type) return null;
    return { name: `custom-map.${type.split('/')[1]}`, bytes: got.bytes, contentType: type, description: `Custom map of job ${formatJobId(job.job_id)}` };
  } catch (err) {
    deps.logger.warn('custom map unavailable', { jobId: job.job_id, err });
    return null;
  }
}

/** Best effort: a renderer problem never fails the command, it only leaves the map out. */
async function routeImage(job: JobDetail, route: ServerRoute, deps: TaskDeps): Promise<Uint8Array<ArrayBuffer> | null> {
  if (route.features.length === 0) return null;
  try {
    const image = await deps.renderer.renderRoute(toRouteRenderRequest(route, { title: `Job ${formatJobId(job.job_id)}` }));
    return image.bytes;
  } catch (err) {
    deps.logger.warn('route image unavailable', { jobId: job.job_id, err });
    return null;
  }
}
