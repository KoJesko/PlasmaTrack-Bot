import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env.ts';
import worker from '../src/index.ts';
import { command, envWithRecordingQueue, INTERACTION_TOKEN, signedRequest, USER_A } from './helpers.ts';

async function call(request: Request, testEnv: Env = env) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request as Request<unknown, IncomingRequestCfProperties>, testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return response;
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

  it('answers /about immediately and queues the notice hint after responding', async () => {
    const { testEnv, sent } = envWithRecordingQueue();
    const res = await call(await signedRequest(command('about')), testEnv);
    const body = (await res.json()) as { type: number; data: { flags: number } };
    expect(body.type).toBe(4);
    expect(body.data.flags & 64).toBe(64);
    expect(sent).toEqual([expect.objectContaining({ type: 'notice-hint' })]);
  });

  it('defers /notices ephemerally and enqueues the task', async () => {
    const { testEnv, sent } = envWithRecordingQueue();
    const res = await call(await signedRequest(command('notices', { dm: true })), testEnv);
    expect(await res.json()).toEqual({ type: 5, data: { flags: 64 } });
    expect(sent).toEqual([
      expect.objectContaining({
        type: 'interaction-task',
        task: { name: 'notices.list', input: null },
        interaction: expect.objectContaining({ userId: USER_A, token: INTERACTION_TOKEN }),
      }),
    ]);
  });

  it('fails closed with a generic message when configuration is invalid', async () => {
    const res = await call(new Request('https://bot.test/healthz'), { ...env, DISCORD_PUBLIC_KEY: 'nope' });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain(env.DISCORD_BOT_TOKEN);
  });
});
