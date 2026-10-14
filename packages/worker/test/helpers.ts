import { env } from 'cloudflare:test';
import { signWebhook, type QueueMessage } from '@plasmatrack/core';
import type { Env } from '../src/env.ts';

export const USER_A = '400000000000000004';
export const USER_B = '500000000000000005';
export const MOD_ROLE = '300000000000000003';
export const GUILD_ID = '200000000000000002';
export const INTERACTION_TOKEN = 'aW50ZXJhY3Rpb246dGVzdC10b2tlbg';

export async function signedRequest(body: unknown, opts: { tamper?: boolean; path?: string } = {}): Promise<Request> {
  const pkcs8 = Uint8Array.from(atob(env.TEST_SIGNING_PKCS8), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(timestamp + raw)));
  const hex = [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
  return new Request(`https://bot.test${opts.path ?? '/interactions'}`, {
    method: 'POST',
    headers: { 'X-Signature-Ed25519': hex, 'X-Signature-Timestamp': timestamp, 'Content-Type': 'application/json' },
    body: opts.tamper ? raw.replace('}', ',"x":1}') : raw,
  });
}

/** A webhook request signed like the PlasmaTrack server signs it (server WEBHOOKS §2). */
export async function signedWebhook(event: { event_id: string; type: string }, secret = env.PLASMATRACK_WEBHOOK_SECRET) {
  const raw = JSON.stringify(event);
  const signature = await signWebhook([secret], new TextEncoder().encode(raw), Date.now() / 1000);
  return new Request('https://bot.test/webhooks/plasmatrack', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-PlasmaTrack-Signature': signature,
      'X-PlasmaTrack-Event': event.type,
      'X-PlasmaTrack-Event-Id': event.event_id,
    },
    body: raw,
  });
}

export function notificationEvent(eventId: string, discordUserId = USER_A) {
  return {
    event_id: eventId,
    type: 'player.notification',
    occurred_at: '2026-10-14T09:20:11.204Z',
    payload_version: 1,
    data: {
      recipient: { user_id: 'usr_1', discord_user_id: discordUserId },
      kind: 'invalid_delivery',
      job_id: '7K2M9QXA',
      game: 'ats',
      title: 'Invalid delivery',
      text: 'This job was over the speed limit for too long and scores 0 points.',
    },
  };
}

export function command(name: string, opts: { user?: string; roles?: string[]; dm?: boolean } = {}) {
  const user = { id: opts.user ?? USER_A, username: 'driver', discriminator: '0', global_name: null, avatar: null };
  return {
    id: '600000000000000006',
    application_id: '100000000000000001',
    type: 2,
    token: INTERACTION_TOKEN,
    version: 1,
    data: { id: '700000000000000007', name, type: 1, options: [] },
    ...(opts.dm
      ? { user }
      : { guild_id: GUILD_ID, member: { user, roles: opts.roles ?? [], permissions: '0', joined_at: '2026-01-01T00:00:00Z', deaf: false, mute: false } }),
  };
}

/** An env whose queue records sends instead of delivering them. */
export function envWithRecordingQueue(): { testEnv: Env; sent: QueueMessage[] } {
  const sent: QueueMessage[] = [];
  const queue = {
    send: async (m: QueueMessage) => {
      sent.push(m);
    },
    sendBatch: async (items: { body: QueueMessage }[]) => {
      for (const i of items) sent.push(i.body);
    },
  } as unknown as Queue<QueueMessage>;
  return { testEnv: { ...env, WORK_QUEUE: queue }, sent };
}
