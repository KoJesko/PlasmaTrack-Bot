import type { APIEmbed } from 'discord-api-types/v10';
import { formatJobId } from '../api/ids.ts';
import { ButtonStyle, ComponentType } from '../discord/constants.ts';
import type { OutgoingMessage } from '../discord/rest.ts';
import type { z } from 'zod';
import type { jobDiscardedSchema, jobNeedsReviewSchema, jobScoredSchema } from './events.ts';

// Review-channel messages (moderators only see the channel). They link to the
// private job view with an "Open" button; the job itself is never acted on
// from the shared message.

type NeedsReview = z.infer<typeof jobNeedsReviewSchema>;
type Scored = z.infer<typeof jobScoredSchema>;
type Discarded = z.infer<typeof jobDiscardedSchema>;

const GAME = (g: string) => (g === 'ets2' ? 'ETS2' : g === 'ats' ? 'ATS' : g.toUpperCase());
const OUTCOME: Record<string, string> = {
  valid: 'Valid',
  approved: 'Approved',
  pending_review: 'In review',
  invalid: 'Invalid',
  rejected: 'Rejected',
  discarded: 'Discarded',
  voided: 'Voided',
};
const label = (o: string) => OUTCOME[o] ?? o;

function openButton(jobId: string) {
  return [
    {
      type: ComponentType.ActionRow,
      components: [{ type: ComponentType.Button, style: ButtonStyle.Primary, label: 'Open', custom_id: `mjob:${jobId}` }],
    },
  ] as OutgoingMessage['components'];
}

function header(job: { job_id: string; game: string; player: { discord_user_id: string; display_name: string } }) {
  return {
    title: `Job ${formatJobId(job.job_id)} · ${GAME(job.game)}`,
    player: `<@${job.player.discord_user_id}> (${job.player.display_name.replace(/[*_`~|]/g, '')})`,
  };
}

export function needsReviewPost(job: NeedsReview): OutgoingMessage {
  const h = header(job);
  const embed: APIEmbed = {
    title: job.origin === 'manual' ? `${h.title} · submitted by hand` : h.title,
    color: job.outcome === 'invalid' ? 0xd62828 : 0xf2a33a,
    description: [
      `**${label(job.outcome)}**${job.held_points !== null && job.held_points !== undefined ? ` · ${job.held_points} points held` : ''}`,
      h.player,
      job.reasons.length > 0 ? `Reasons: ${job.reasons.map((r) => `\`${r.code}\``).join(', ')}` : null,
      job.delivered_at && !Number.isNaN(Date.parse(job.delivered_at)) ? `Delivered <t:${Math.floor(Date.parse(job.delivered_at) / 1000)}:R>` : null,
    ]
      .filter(Boolean)
      .join('\n'),
  };
  return { embeds: [embed], components: openButton(job.job_id), allowed_mentions: { parse: [] } };
}

export function resolvedPost(job: Scored | Discarded): OutgoingMessage {
  const h = header(job);
  const scored = 'outcome' in job;
  const outcome = scored ? (job as Scored).outcome : 'discarded';
  const by = scored ? (job as Scored).by : undefined;
  const who =
    by?.kind === 'moderator' && by.discord_user_id ? `by <@${by.discord_user_id}>` : by?.kind === 'recalculation' ? 'by a recalculation' : by?.kind === 'rules' ? 'automatically' : '';
  const points = scored && (job as Scored).points !== null ? ` · ${(job as Scored).points} points` : '';
  const reasons = !scored && (job as Discarded).reasons.length > 0 ? ` (${(job as Discarded).reasons.map((r) => `\`${r}\``).join(', ')})` : '';
  const embed: APIEmbed = {
    title: h.title,
    color: outcome === 'approved' || outcome === 'valid' ? 0x2e9e5b : 0x6b6b6b,
    description: `**${label(outcome)}**${points} ${who}${reasons}\n${h.player}`.trim(),
  };
  return { embeds: [embed], components: openButton(job.job_id), allowed_mentions: { parse: [] } };
}

export function operationPost(op: { operation_id: string; kind: string; status: string; summary?: Record<string, unknown> | null; requested_by?: { discord_user_id: string } | undefined }): OutgoingMessage {
  const changed = op.summary && typeof op.summary['changed'] === 'object' && op.summary['changed'] ? Object.entries(op.summary['changed'] as Record<string, unknown>) : [];
  const jobs = op.summary && typeof op.summary['jobs'] === 'number' ? ` ${op.summary['jobs']} jobs.` : '';
  return {
    content: [
      `The ${op.kind} \`${op.operation_id}\`${op.requested_by ? ` started by <@${op.requested_by.discord_user_id}>` : ''} has **${op.status}**.${jobs}`,
      ...changed.map(([k, v]) => `• ${k}: ${String(v)}`),
    ]
      .join('\n')
      .slice(0, 2000),
    allowed_mentions: { parse: [] },
  };
}
