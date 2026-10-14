import type { QueueMessage } from '../interactions/types.ts';
import type { Logger } from '../log.ts';
import type { Clock, WorkQueue } from '../ports.ts';
import { SUPPORTED_PAYLOAD_VERSION, webhookEnvelopeSchema, type WebhookEnvelope } from './events.ts';
import { verifyWebhookSignature, WEBHOOK_MAX_BYTES } from './signature.ts';

// The HTTP side of server → bot webhooks: check, then queue. All real work
// (DMs, fan-out) happens in the queue consumer, so the server gets its 2xx
// well inside its 10 s limit (server WEBHOOKS §3).

/** Revocation recipient lists are split so every queue message stays small (Queues: 128 KB per message). */
export const RECIPIENTS_PER_MESSAGE = 250;

export interface WebhookRequest {
  body: Uint8Array;
  signature: string | null;
  eventIdHeader: string | null;
}

export interface WebhookReceiveDeps {
  /**
   * Signing secrets per backend. Each backend has its own, so the secret that
   * verifies tells which backend sent the event. Empty: not configured.
   */
  secrets: Readonly<Record<string, readonly string[]>>;
  queue: WorkQueue<QueueMessage>;
  logger: Logger;
  clock: Clock;
}

export interface WebhookResponse {
  status: number;
  body: string;
}

export async function receiveWebhook(req: WebhookRequest, deps: WebhookReceiveDeps): Promise<WebhookResponse> {
  const configured = Object.entries(deps.secrets).filter(([, s]) => s.length > 0);
  if (configured.length === 0) return { status: 503, body: 'webhooks are not configured' };
  if (req.body.length > WEBHOOK_MAX_BYTES) return { status: 413, body: 'payload too large' };

  let backend: string | undefined;
  for (const [name, secrets] of configured) {
    if (await verifyWebhookSignature(secrets, req.signature, req.body, deps.clock.now() / 1000)) {
      backend = name;
      break;
    }
  }
  if (!backend) return { status: 401, body: 'invalid signature' };

  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(req.body));
  } catch {
    return { status: 400, body: 'invalid JSON' };
  }
  const parsed = webhookEnvelopeSchema.safeParse(json);
  if (!parsed.success) return { status: 400, body: 'invalid envelope' };
  const event = parsed.data;
  if (req.eventIdHeader !== null && req.eventIdHeader !== event.event_id) {
    return { status: 400, body: 'event id header does not match the body' };
  }

  if (event.payload_version !== SUPPORTED_PAYLOAD_VERSION) {
    // Retrying won't help until the bot is updated; take it so the server stops retrying.
    deps.logger.error('webhook with unsupported payload_version ignored', {
      backend,
      type: event.type,
      eventId: event.event_id,
      payloadVersion: event.payload_version,
    });
    return { status: 202, body: 'ignored: unsupported payload_version' };
  }

  try {
    await deps.queue.sendBatch(split(event).map((e, chunk) => ({ type: 'webhook', backend: backend!, event: e, chunk })));
  } catch (err) {
    // The server retries on any non-2xx.
    deps.logger.error('could not queue webhook', { type: event.type, eventId: event.event_id, err });
    return { status: 503, body: 'try again later' };
  }
  return { status: 202, body: 'accepted' };
}

function split(event: WebhookEnvelope): WebhookEnvelope[] {
  const recipients = event.data['recipients'];
  if (!Array.isArray(recipients) || recipients.length <= RECIPIENTS_PER_MESSAGE) return [event];
  const out: WebhookEnvelope[] = [];
  for (let i = 0; i < recipients.length; i += RECIPIENTS_PER_MESSAGE) {
    out.push({ ...event, data: { ...event.data, recipients: recipients.slice(i, i + RECIPIENTS_PER_MESSAGE) } });
  }
  return out;
}
