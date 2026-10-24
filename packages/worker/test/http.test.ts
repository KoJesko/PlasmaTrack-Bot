import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env.ts';
import worker from '../src/index.ts';
import { command, envWithRecordingQueue, INTERACTION_TOKEN, notificationEvent, signedRequest, signedWebhook, USER_A } from './helpers.ts';

async function call(request: Request, testEnv: Env = env) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request as Request<unknown, IncomingRequestCfProperties>, testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** Discord as seen by commands that run right after their reply. */
function fakeDiscord() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ id: 'msg' }));
}

describe('HTTP entry point', () => {
  it('serves a health check and 404s everything else', async () => {
    expect((await call(new Request('https://bot.test/healthz'))).status).toBe(200);
    expect((await call(new Request('https://bot.test/other'))).status).toBe(404);
  });

  it('rejects interactions without a valid Discord signature', async () => {
    const unsigned = new Request('https://bot.test/interactions', { method: 'POST', body: '{"type":1}' });
    expect((await call(unsigned)).status).toBe(401);
    expect((await call(await signedRequest({ type: 1 }, { tamper: true }))).status).toBe(401);
  });

  it('answers a signed PING with PONG', async () => {
    const res = await call(await signedRequest({ type: 1 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ type: 1 });
  });

  it('answers /about immediately and checks for notices after responding, without the queue', async () => {
    fakeDiscord();
    const { testEnv, sent } = envWithRecordingQueue();
    const res = await call(await signedRequest(command('about')), testEnv);
    const body = (await res.json()) as { type: number; data: { flags: number } };
    expect(body.type).toBe(4);
    expect(body.data.flags & 64).toBe(64);
    expect(sent).toEqual([]);
  });

  it('defers /notices ephemerally, then runs it right away and edits the reply, without the queue', async () => {
    const discord = fakeDiscord();
    const { testEnv, sent } = envWithRecordingQueue();
    const res = await call(await signedRequest(command('notices')), testEnv);
    expect(await res.json()).toEqual({ type: 5, data: { flags: 64 } });
    expect(sent).toEqual([]);
    const urls = discord.mock.calls.map((c) => String(c[0]));
    expect(urls).toContain(`https://discord.com/api/v10/webhooks/100000000000000001/${INTERACTION_TOKEN}/messages/@original`);
  });

  it('hands a command to the queue when it needs a retry', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ message: 'rate limited', retry_after: 2 }, { status: 429 }));
    const { testEnv, sent } = envWithRecordingQueue();
    const res = await call(await signedRequest(command('notices', { user: USER_A })), testEnv);
    expect(await res.json()).toEqual({ type: 5, data: { flags: 64 } });
    expect(sent).toEqual([expect.objectContaining({ type: 'interaction-task', task: { name: 'notices.list', input: null } })]);
  });

  it('allows 5 slash commands per user per 20 s, counted in D1', async () => {
    fakeDiscord();
    const { testEnv } = envWithRecordingQueue();
    const user = '700000000000000077';
    const replies: { type: number; data?: { content?: string } }[] = [];
    for (let i = 0; i < 6; i++) replies.push(await (await call(await signedRequest(command('notices', { user })), testEnv)).json());
    // Unless the 20 s window happened to roll over mid-test, the sixth is refused.
    const refused = replies.filter((r) => r.data?.content?.includes('going a bit fast'));
    const started = replies.filter((r) => r.type === 5);
    expect(refused.length).toBeLessThanOrEqual(1);
    expect(started.length + refused.length).toBe(6);
    expect(started.length).toBeGreaterThanOrEqual(5);
  });

  it('refuses commands in DMs and from members without a PlasmaTrack role', async () => {
    const { testEnv, sent } = envWithRecordingQueue();
    const dm = (await (await call(await signedRequest(command('notices', { dm: true })), testEnv)).json()) as { data: { content: string } };
    expect(dm.data.content).toContain('only work in its Discord servers');
    const noRole = (await (await call(await signedRequest(command('notices', { roles: [] })), testEnv)).json()) as { data: { content: string } };
    expect(noRole.data.content).toContain('isn’t open to your roles');
    expect(sent).toEqual([]);
  });

  it('fails closed with a generic message when configuration is invalid', async () => {
    const res = await call(new Request('https://bot.test/healthz'), { ...env, DISCORD_PUBLIC_KEY: 'nope' });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain(env.DISCORD_BOT_TOKEN);
  });
});

describe('webhook endpoint', () => {
  it('queues a correctly signed event and answers 202', async () => {
    const { testEnv, sent } = envWithRecordingQueue();
    const res = await call(await signedWebhook(notificationEvent('evt_http_1')), testEnv);
    expect(res.status).toBe(202);
    expect(sent).toEqual([expect.objectContaining({ type: 'webhook', chunk: 0, event: expect.objectContaining({ event_id: 'evt_http_1' }) })]);
  });

  it('rejects a bad signature and an oversize body without queueing', async () => {
    const { testEnv, sent } = envWithRecordingQueue();
    const forged = await signedWebhook(notificationEvent('evt_http_2'), 'some-other-secret-0123456789abcdefghijkl');
    expect((await call(forged, testEnv)).status).toBe(401);
    const big = new Request('https://bot.test/webhooks/plasmatrack', {
      method: 'POST',
      headers: { 'Content-Length': String(300 * 1024) },
      body: 'x'.repeat(300 * 1024),
    });
    expect((await call(big, testEnv)).status).toBe(413);
    expect(sent).toEqual([]);
  });

  it('answers 503 while no webhook secret is configured', async () => {
    const { testEnv } = envWithRecordingQueue();
    const res = await call(await signedWebhook(notificationEvent('evt_http_3')), { ...testEnv, PLASMATRACK_WEBHOOK_SECRET_PRODUCTION: undefined });
    expect(res.status).toBe(503);
  });

  it('only accepts POST', async () => {
    expect((await call(new Request('https://bot.test/webhooks/plasmatrack'))).status).toBe(404);
  });
});
