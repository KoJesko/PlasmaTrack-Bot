import { describe, expect, it } from 'vitest';
import { bytesToHex, utf8 } from '../src/bytes.ts';
import { DiscordApiError } from '../src/discord/rest.ts';
import { processQueueMessage } from '../src/interactions/tasks.ts';
import type { QueueMessage } from '../src/interactions/types.ts';
import { MemoryWorkQueue } from '../src/memory.ts';
import { receiveWebhook, RECIPIENTS_PER_MESSAGE } from '../src/webhooks/receive.ts';
import { parseSignatureHeader, signWebhook, verifyWebhookSignature, WEBHOOK_MAX_BYTES } from '../src/webhooks/signature.ts';
import { captureLogger, FakeClock, taskDeps } from './helpers.ts';

const SECRET = 'whsec-test-0123456789abcdefghijklmnopqrstuv';
const NEW_SECRET = 'whsec-next-0123456789abcdefghijklmnopqrstuv';
const PLAYER = '123456789012345678';
const PLAYER_2 = '234567890123456789';

function envelope(type: string, data: Record<string, unknown>, eventId = 'evt_01JAB7C9X2') {
  return { event_id: eventId, type, occurred_at: '2026-10-14T09:20:11.204Z', payload_version: 1, data };
}

const notification = (eventId = 'evt_note_1') =>
  envelope(
    'player.notification',
    {
      recipient: { user_id: 'usr_8f3k2m', discord_user_id: PLAYER },
      kind: 'speed_penalty_activated',
      job_id: '7K2M9QXA',
      game: 'ets2',
      happened_at: '2026-10-13T20:44:10.500Z',
      title: 'Speed penalty',
      text: 'You drove over 100 mph for too long. This job’s distance now counts at 0.85×.',
    },
    eventId,
  );

const revocation = (recipients: string[], type = 'version.revocation_scheduled') =>
  envelope(
    type,
    {
      revocation_id: 'rev_k2',
      target: { kind: 'release', id: 'rel_0_1_0', label: 'PlasmaTrack 0.1.0 (Windows)' },
      announced_at: '2026-10-14T09:00:00.000Z',
      effective_at: '2026-11-04T09:00:00.000Z',
      message: 'PlasmaTrack 0.1.0 stops counting jobs on 4 November 2026 at 09:00 UTC. Run PlasmaTrack Setup to update.',
      recipients,
      part: 1,
      parts: 1,
    },
    `evt_${type}`,
  );

const jobScored = (version: number, eventId: string) =>
  envelope(
    'job.scored',
    {
      job_id: '7K2M9QXA',
      game: 'ets2',
      job_version: version,
      player: { user_id: 'usr_8f3k2m', discord_user_id: PLAYER, display_name: 'KoJesko' },
      outcome: 'approved',
      previous_outcome: 'pending_review',
      points: 90.3,
      held_points: null,
      by: { kind: 'moderator', discord_user_id: '987654321098765432' },
    },
    eventId,
  );

async function signed(event: unknown, clock: FakeClock, secrets = [SECRET]) {
  const body = utf8(JSON.stringify(event));
  return { body, signature: await signWebhook(secrets, body, clock.now() / 1000), eventIdHeader: (event as { event_id: string }).event_id };
}

function receiver(clock = new FakeClock(), secrets = [SECRET]) {
  const queue = new MemoryWorkQueue<QueueMessage>();
  const { logger, lines } = captureLogger();
  return { queue, lines, deps: { secrets, queue, logger, clock }, clock };
}

describe('webhook signature', () => {
  it('matches the server’s documented algorithm', async () => {
    // HMAC-SHA256(secret, "{t}.{raw body}") in lowercase hex, computed independently.
    const body = utf8('{"a":1}');
    const key = await crypto.subtle.importKey('raw', utf8('k'.repeat(32)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const expected = bytesToHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8('1700000000.{"a":1}'))));
    expect(await signWebhook(['k'.repeat(32)], body, 1700000000)).toBe(`t=1700000000,v1=${expected}`);
  });

  it('accepts either signature during a rotation, from either side', async () => {
    const body = utf8('{}');
    const both = await signWebhook([SECRET, NEW_SECRET], body, 1000);
    expect(parseSignatureHeader(both)!.signatures).toHaveLength(2);
    expect(await verifyWebhookSignature([NEW_SECRET], both, body, 1000)).toBe(true);
    expect(await verifyWebhookSignature([SECRET], both, body, 1000)).toBe(true);
    const onlyNew = await signWebhook([NEW_SECRET], body, 1000);
    expect(await verifyWebhookSignature([SECRET, NEW_SECRET], onlyNew, body, 1000)).toBe(true);
  });

  it('rejects a wrong secret, a changed body, an old timestamp and junk headers', async () => {
    const body = utf8('{"x":1}');
    const sig = await signWebhook([SECRET], body, 1000);
    expect(await verifyWebhookSignature([NEW_SECRET], sig, body, 1000)).toBe(false);
    expect(await verifyWebhookSignature([SECRET], sig, utf8('{"x":2}'), 1000)).toBe(false);
    expect(await verifyWebhookSignature([SECRET], sig, body, 1000 + 301)).toBe(false);
    expect(await verifyWebhookSignature([SECRET], sig, body, 1000 - 301)).toBe(false);
    expect(await verifyWebhookSignature([SECRET], sig, body, 1000 + 300)).toBe(true);
    for (const junk of [null, '', 't=1000', 'v1=abc', `t=abc,${sig.split(',')[1]}`]) {
      expect(await verifyWebhookSignature([SECRET], junk, body, 1000)).toBe(false);
    }
  });
});

describe('receiveWebhook', () => {
  it('queues a verified event and answers 202', async () => {
    const r = receiver();
    const res = await receiveWebhook(await signed(notification(), r.clock), r.deps);
    expect(res.status).toBe(202);
    expect(r.queue.take()).toEqual([{ type: 'webhook', event: notification(), chunk: 0 }]);
  });

  it('answers 503 when no secret is configured, so the server retries later', async () => {
    const r = receiver(new FakeClock(), []);
    expect((await receiveWebhook(await signed(notification(), r.clock), r.deps)).status).toBe(503);
  });

  it('rejects bad signatures, oversize bodies, bad JSON and mismatched IDs before queueing', async () => {
    const r = receiver();
    const good = await signed(notification(), r.clock);
    expect((await receiveWebhook({ ...good, signature: await signWebhook([NEW_SECRET], good.body, r.clock.now() / 1000) }, r.deps)).status).toBe(401);
    const big = new Uint8Array(WEBHOOK_MAX_BYTES + 1);
    expect((await receiveWebhook({ body: big, signature: good.signature, eventIdHeader: null }, r.deps)).status).toBe(413);
    const notJson = utf8('not json');
    expect((await receiveWebhook({ body: notJson, signature: await signWebhook([SECRET], notJson, r.clock.now() / 1000), eventIdHeader: null }, r.deps)).status).toBe(400);
    expect((await receiveWebhook({ ...good, eventIdHeader: 'evt_other' }, r.deps)).status).toBe(400);
    expect(r.queue.items).toHaveLength(0);
  });

  it('takes but ignores an unsupported payload_version', async () => {
    const r = receiver();
    const res = await receiveWebhook(await signed({ ...notification(), payload_version: 2 }, r.clock), r.deps);
    expect(res.status).toBe(202);
    expect(r.queue.items).toHaveLength(0);
    expect(r.lines.some((l) => l.level === 'error')).toBe(true);
  });

  it('splits a large recipient list over several queue messages', async () => {
    const r = receiver();
    const recipients = Array.from({ length: 1000 }, (_, i) => String(100000000000000000n + BigInt(i)));
    await receiveWebhook(await signed(revocation(recipients), r.clock), r.deps);
    const queued = r.queue.take() as Extract<QueueMessage, { type: 'webhook' }>[];
    expect(queued.map((m) => m.chunk)).toEqual([0, 1, 2, 3]);
    expect(queued.every((m) => (m.event.data['recipients'] as string[]).length === RECIPIENTS_PER_MESSAGE)).toBe(true);
    expect(queued.every((m) => JSON.stringify(m).length < 120_000)).toBe(true);
  });

  it('answers 503 if the queue is down, so the server retries', async () => {
    const r = receiver();
    r.queue.sendBatch = async () => {
      throw new Error('queue unavailable');
    };
    expect((await receiveWebhook(await signed(notification(), r.clock), r.deps)).status).toBe(503);
  });
});

describe('webhook processing', () => {
  const webhook = (event: ReturnType<typeof envelope>, chunk = 0): QueueMessage => ({ type: 'webhook', event, chunk });

  it('DMs a player notification immediately', async () => {
    const { deps, discord } = taskDeps();
    expect(await processQueueMessage(webhook(notification()), [], deps)).toEqual({ status: 'done' });
    expect(discord.calls).toHaveLength(1);
    expect(discord.calls[0]).toMatchObject({ op: 'dm', target: PLAYER });
    const embed = (discord.calls[0]!.message as { embeds: { title: string; footer: { text: string } }[] }).embeds[0]!;
    expect(embed.title).toBe('Speed penalty');
    expect(embed.footer.text).toBe('Job 7K2M-9QXA · ETS2');
  });

  it('handles a redelivered event only once', async () => {
    const { deps, discord } = taskDeps();
    await processQueueMessage(webhook(notification()), [], deps);
    await processQueueMessage(webhook(notification()), [], deps);
    expect(discord.calls).toHaveLength(1);
  });

  it('keeps the notice for /notices when the player’s DMs are closed', async () => {
    const { deps, discord, notices } = taskDeps();
    discord.dmFailures.set(PLAYER, new DiscordApiError(403, 50007, undefined, 'Cannot send messages to this user'));
    expect(await processQueueMessage(webhook(notification()), [], deps)).toEqual({ status: 'done' });
    const stored = await notices.listUnread(PLAYER, 10);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ kind: 'speed_penalty' });
    expect(stored[0]!.text).toContain('Speed penalty');
    // Never visible to anyone else.
    expect(await notices.countUnread(PLAYER_2)).toBe(0);
  });

  it('retries when Discord is rate limiting, and does not count the attempt as done', async () => {
    const { deps, discord } = taskDeps();
    discord.dmFailures.set(PLAYER, new DiscordApiError(429, undefined, 3, 'rate limited'));
    expect(await processQueueMessage(webhook(notification()), [], deps)).toEqual({ status: 'retry', delaySeconds: 3 });
    discord.dmFailures.clear();
    await processQueueMessage(webhook(notification()), [], deps);
    expect(discord.calls.filter((c) => c.op === 'dm')).toHaveLength(1);
  });

  it('fans revocation DMs out, one queue message per player, and deduplicates them', async () => {
    const { deps, discord, queue } = taskDeps();
    await processQueueMessage(webhook(revocation([PLAYER, PLAYER_2, PLAYER])), [], deps);
    const dms = queue.take();
    expect(dms.map((m) => m.type === 'player-dm' && m.userId)).toEqual([PLAYER, PLAYER_2]);
    for (const m of [...dms, dms[0]!]) await processQueueMessage(m, [], deps);
    expect(discord.calls.map((c) => c.target)).toEqual([PLAYER, PLAYER_2]);
    const embed = (discord.calls[0]!.message as { embeds: { title: string; description: string }[] }).embeds[0]!;
    expect(embed.title).toBe('Update needed: PlasmaTrack 0.1.0 (Windows)');
    expect(embed.description).toContain(`<t:${Date.parse('2026-11-04T09:00:00.000Z') / 1000}:F>`);
  });

  it('tells players when a revocation is cancelled', async () => {
    const { deps, discord, queue } = taskDeps();
    await processQueueMessage(webhook(revocation([PLAYER], 'version.revocation_cancelled')), [], deps);
    for (const m of queue.take()) await processQueueMessage(m, [], deps);
    const embed = (discord.calls[0]!.message as { embeds: { title: string }[] }).embeds[0]!;
    expect(embed.title).toBe('No update needed: PlasmaTrack 0.1.0 (Windows)');
  });

  it('ignores a job event older than one already handled', async () => {
    const { deps, lines } = taskDeps();
    await processQueueMessage(webhook(jobScored(5, 'evt_a')), [], deps);
    await processQueueMessage(webhook(jobScored(4, 'evt_b')), [], deps);
    expect(lines.filter((l) => l.line.includes('stale job event ignored'))).toHaveLength(1);
  });

  it('accepts unknown event types and malformed payloads without retrying', async () => {
    const { deps, discord, lines } = taskDeps();
    expect(await processQueueMessage(webhook(envelope('job.teleported', {}, 'evt_x')), [], deps)).toEqual({ status: 'done' });
    expect(await processQueueMessage(webhook(envelope('player.notification', { kind: 'x' }, 'evt_y')), [], deps)).toEqual({ status: 'done' });
    expect(discord.calls).toHaveLength(0);
    const err = lines.find((l) => l.line.includes('does not match the contract'))!;
    expect(err.line).toContain('recipient');
  });
});
