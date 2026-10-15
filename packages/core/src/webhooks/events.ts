import { z } from 'zod';
import { playerRefSchema, reasonSchema } from '../api/schemas.ts';

// Webhook envelope and event payloads (server WEBHOOKS §3–4), payload_version 1.
// Objects are loose: new optional fields may appear at any time.

const obj = <S extends z.ZodRawShape>(shape: S) => z.looseObject(shape);

export const SUPPORTED_PAYLOAD_VERSION = 1;

export const webhookEnvelopeSchema = obj({
  event_id: z.string().min(1).max(128),
  type: z.string().min(1).max(64),
  occurred_at: z.string(),
  payload_version: z.number().int(),
  data: z.record(z.string(), z.unknown()),
});
export type WebhookEnvelope = z.infer<typeof webhookEnvelopeSchema>;

const jobEventBase = {
  job_id: z.string(),
  game: z.string(),
  job_version: z.number().int(),
  player: playerRefSchema,
};

export const jobNeedsReviewSchema = obj({
  ...jobEventBase,
  outcome: z.string(),
  held_points: z.number().nullable().optional(),
  reasons: z.array(reasonSchema).default([]),
  delivered_at: z.string().optional(),
  /** `manual` for a job submitted through the bot. */
  origin: z.string().optional(),
});

export const jobScoredSchema = obj({
  ...jobEventBase,
  outcome: z.string(),
  previous_outcome: z.string().nullable().optional(),
  points: z.number().nullable(),
  held_points: z.number().nullable().optional(),
  by: obj({ kind: z.string(), discord_user_id: z.string().optional(), operation_id: z.string().optional() }).optional(),
});

export const jobDiscardedSchema = obj({
  ...jobEventBase,
  reasons: z.array(z.string()).default([]),
});

export const playerNotificationSchema = obj({
  recipient: obj({ user_id: z.string().optional(), discord_user_id: z.string().regex(/^\d{17,20}$/) }),
  kind: z.string(),
  job_id: z.string().nullable().optional(),
  game: z.string().nullable().optional(),
  happened_at: z.string().optional(),
  title: z.string().min(1).max(256),
  text: z.string().min(1).max(2000),
});
export type PlayerNotification = z.infer<typeof playerNotificationSchema>;

const revocationTarget = obj({ kind: z.string(), id: z.string(), label: z.string().optional() });
const recipients = z.array(z.string().regex(/^\d{17,20}$/)).max(1000);

export const revocationScheduledSchema = obj({
  revocation_id: z.string(),
  target: revocationTarget,
  announced_at: z.string().optional(),
  effective_at: z.string(),
  message: z.string().min(1).max(2000),
  recipients,
  part: z.number().int().optional(),
  parts: z.number().int().optional(),
});
export type RevocationScheduled = z.infer<typeof revocationScheduledSchema>;

export const revocationCancelledSchema = obj({
  revocation_id: z.string(),
  target: revocationTarget,
  recipients,
  part: z.number().int().optional(),
  parts: z.number().int().optional(),
});
export type RevocationCancelled = z.infer<typeof revocationCancelledSchema>;

export const operationCompletedSchema = obj({
  operation_id: z.string(),
  kind: z.string(),
  status: z.string(),
  summary: z.record(z.string(), z.unknown()).nullable().optional(),
  requested_by: obj({ discord_user_id: z.string() }).optional(),
});
