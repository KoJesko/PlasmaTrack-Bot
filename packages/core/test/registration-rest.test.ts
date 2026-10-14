import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { handlers } from '../src/commands/index.ts';
import { buildCommandRegistration } from '../src/commands/registration.ts';
import { DiscordApiError, DiscordRest } from '../src/discord/rest.ts';
import { APP_ID, INTERACTION_TOKEN } from './helpers.ts';

describe('buildCommandRegistration', () => {
  const reg = buildCommandRegistration([
    ...handlers.commands,
    { access: 'moderator', json: { name: 'review', description: 'test' }, handle: () => ({ kind: 'modal', modal: { custom_id: 'x', title: 'x', components: [] } }) },
  ]);

  it('registers player commands globally for the guild and bot DMs', () => {
    expect(reg.global.map((c) => c.name).sort()).toEqual(['about', 'notices']);
    for (const c of reg.global) {
      expect(c.contexts).toEqual([0, 1]);
      expect(c.integration_types).toEqual([0]);
    }
  });

  it('registers moderator commands only in the guild, hidden by default', () => {
    expect(reg.guild).toEqual([{ name: 'review', description: 'test', default_member_permissions: '0' }]);
  });

  it('rejects duplicate names', () => {
    expect(() => buildCommandRegistration([handlers.commands[0]!, handlers.commands[0]!])).toThrow(/duplicate/);
  });
});

describe('DiscordRest', () => {
  function fakeFetch(respond: (url: string, init: RequestInit) => Response) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return respond(url, init);
    }) as unknown as typeof fetch;
    return { fn, calls };
  }

  it('edits the original reply without bot auth, and never lets content ping anyone', async () => {
    const { fn, calls } = fakeFetch(() => Response.json({ id: '1' }));
    const rest = new DiscordRest({ applicationId: APP_ID, botToken: 'bot-token-value-123', fetch: fn });
    await rest.editOriginal(INTERACTION_TOKEN, { content: '@everyone hi' });
    expect(calls[0]!.url).toBe(`https://discord.com/api/v10/webhooks/${APP_ID}/${INTERACTION_TOKEN}/messages/@original`);
    expect(calls[0]!.init.method).toBe('PATCH');
    expect((calls[0]!.init.headers as Record<string, string>)['Authorization']).toBeUndefined();
    expect(JSON.parse(calls[0]!.init.body as string).allowed_mentions).toEqual({ parse: [] });
  });

  it('uploads files as multipart with matching attachment entries', async () => {
    const { fn, calls } = fakeFetch(() => Response.json({ id: '1' }));
    const rest = new DiscordRest({ applicationId: APP_ID, botToken: 'x'.repeat(30), fetch: fn });
    await rest.followup(INTERACTION_TOKEN, { content: 'map' }, [
      { name: 'route.png', bytes: new Uint8Array([137, 80, 78, 71]), contentType: 'image/png', description: 'Route' },
    ]);
    const form = calls[0]!.init.body as FormData;
    const payload = JSON.parse(form.get('payload_json') as string);
    expect(payload.attachments).toEqual([{ id: 0, filename: 'route.png', description: 'Route' }]);
    const file = form.get('files[0]') as File;
    expect(file.name).toBe('route.png');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));
  });

  it('opens a DM channel then posts, with bot auth', async () => {
    const { fn, calls } = fakeFetch((url) => (url.endsWith('/users/@me/channels') ? Response.json({ id: '42' }) : Response.json({})));
    const rest = new DiscordRest({ applicationId: APP_ID, botToken: 'bot-token-value-123', fetch: fn });
    await rest.sendDirectMessage('400000000000000004', { content: 'hi' });
    expect(calls.map((c) => c.url.replace('https://discord.com/api/v10', ''))).toEqual(['/users/@me/channels', '/channels/42/messages']);
    expect((calls[1]!.init.headers as Record<string, string>)['Authorization']).toBe('Bot bot-token-value-123');
  });

  it('parses errors (429 retry_after, DM closed code) without leaking the token', async () => {
    const { fn } = fakeFetch(() => Response.json({ message: 'You are being rate limited.', retry_after: 1.5, global: false }, { status: 429 }));
    const rest = new DiscordRest({ applicationId: APP_ID, botToken: 'x'.repeat(30), fetch: fn });
    const err = (await rest.editOriginal(INTERACTION_TOKEN, { content: 'x' }).catch((e) => e)) as DiscordApiError;
    expect(err).toBeInstanceOf(DiscordApiError);
    expect(err.retryable).toBe(true);
    expect(err.retryAfterSeconds).toBe(1.5);
    expect(err.message).not.toContain(INTERACTION_TOKEN);

    const closed = fakeFetch(() => Response.json({ message: 'Cannot send messages to this user', code: 50007 }, { status: 403 }));
    const rest2 = new DiscordRest({ applicationId: APP_ID, botToken: 'x'.repeat(30), fetch: closed.fn });
    const err2 = (await rest2.sendDirectMessage('1', { content: 'x' }).catch((e) => e)) as DiscordApiError;
    expect(err2.code).toBe(50007);
    expect(err2.retryable).toBe(false);
  });
});

describe('portability', () => {
  it('core source never imports Cloudflare- or Node-specific modules', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) files.push(p);
      }
    };
    walk(join(import.meta.dirname, '..', 'src'));
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).not.toMatch(/from ['"](cloudflare:|node:|@cloudflare\/)/);
      expect(src, f).not.toMatch(/\b(D1Database|R2Bucket|KVNamespace|ExecutionContext)\b/);
      // Types only: discord-api-types' runtime enums are CommonJS and broke under workerd.
      expect(src, f).not.toMatch(/^import (?!type )[^;]*from 'discord-api-types/m);
    }
  });
});
