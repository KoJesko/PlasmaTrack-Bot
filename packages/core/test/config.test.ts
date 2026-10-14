import { describe, expect, it } from 'vitest';
import { ConfigError, parseBotConfig, secretValues } from '../src/config.ts';

const PLASMA = '290938481574936588';
const JWL = '111169345330321821';

const valid = {
  DISCORD_APPLICATION_ID: '100000000000000001',
  DISCORD_PUBLIC_KEY: 'a'.repeat(64),
  DISCORD_BOT_TOKEN: 'MTAwMDAwMDAwMDAwMDAwMDAx.secret-bot-token',
  RENDERER_URL: 'https://renderer.example.org',
  RENDERER_KEY: 'k'.repeat(40),
  // As wrangler passes [vars.GUILDS.<id>] tables: objects.
  GUILDS: {
    [PLASMA]: { backend: 'production', member_roles: ['300000000000000013'], moderator_roles: ['300000000000000003'] },
    [JWL]: { backend: 'test', moderator_roles: ['300000000000000004'], review_channel: '400000000000000004' },
  },
  BACKENDS: { production: {}, test: { demo: true } },
};

function problems(env: Record<string, unknown>): string {
  try {
    parseBotConfig(env);
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as Error).message;
  }
  throw new Error('expected a ConfigError');
}

describe('parseBotConfig', () => {
  it('parses per-server settings and applies defaults', () => {
    const cfg = parseBotConfig(valid);
    expect(cfg.NOTICE_TTL_DAYS).toBe(30);
    expect(cfg.GUILDS[PLASMA]).toEqual({
      backend: 'production',
      member_roles: ['300000000000000013'],
      moderator_roles: ['300000000000000003'],
      review_channel: undefined,
    });
    expect(cfg.GUILDS[JWL]!.member_roles).toEqual([]);
    expect(cfg.GUILDS[JWL]!.review_channel).toBe('400000000000000004');
    expect(cfg.BACKENDS['production']).toEqual({ name: 'production', apiUrl: undefined, demo: false, botToken: undefined, webhookSecrets: [] });
    expect(cfg.BACKENDS['test']!.demo).toBe(true);
  });

  it('accepts GUILDS and BACKENDS as JSON strings too', () => {
    const cfg = parseBotConfig({ ...valid, GUILDS: JSON.stringify(valid.GUILDS), BACKENDS: JSON.stringify(valid.BACKENDS) });
    expect(Object.keys(cfg.GUILDS)).toEqual([PLASMA, JWL]);
  });

  it('reads each backend’s secrets from its own keys and treats them as secrets', () => {
    const cfg = parseBotConfig({
      ...valid,
      BACKENDS: { production: { api_url: 'https://pt.example.org' }, test: { demo: true } },
      PLASMATRACK_BOT_TOKEN_PRODUCTION: 'pt_bot_0123456789abcdef',
      PLASMATRACK_WEBHOOK_SECRET_PRODUCTION: `${'a'.repeat(43)}, ${'b'.repeat(43)}`,
      PLASMATRACK_WEBHOOK_SECRET_TEST: 'c'.repeat(43),
    });
    expect(cfg.BACKENDS['production']).toMatchObject({ apiUrl: 'https://pt.example.org', botToken: 'pt_bot_0123456789abcdef' });
    expect(cfg.BACKENDS['production']!.webhookSecrets).toEqual(['a'.repeat(43), 'b'.repeat(43)]);
    expect(cfg.BACKENDS['test']!.webhookSecrets).toEqual(['c'.repeat(43)]);
    expect(secretValues(cfg)).toEqual(expect.arrayContaining(['pt_bot_0123456789abcdef', 'a'.repeat(43), 'c'.repeat(43), valid.RENDERER_KEY]));
  });

  it('rejects a guild pointing at an unknown backend, and a server URL without its token', () => {
    const msg = problems({
      ...valid,
      GUILDS: { [PLASMA]: { backend: 'staging' } },
      BACKENDS: { production: { api_url: 'https://pt.example.org' } },
    });
    expect(msg).toContain(`GUILDS.${PLASMA}.backend`);
    expect(msg).toContain('PLASMATRACK_BOT_TOKEN_PRODUCTION');
  });

  it('refuses two backends sharing a webhook secret (it identifies the backend)', () => {
    const msg = problems({ ...valid, PLASMATRACK_WEBHOOK_SECRET_PRODUCTION: 'd'.repeat(43), PLASMATRACK_WEBHOOK_SECRET_TEST: 'd'.repeat(43) });
    expect(msg).toContain('shared with another backend');
    expect(msg).not.toContain('d'.repeat(43));
  });

  it('names missing or invalid keys without echoing any value', () => {
    const msg = problems({ ...valid, DISCORD_BOT_TOKEN: undefined, RENDERER_KEY: 'short-secret-value', GUILDS: { nope: { backend: 'production' } } });
    expect(msg).toContain('DISCORD_BOT_TOKEN');
    expect(msg).toContain('RENDERER_KEY');
    expect(msg).toContain('GUILDS');
    expect(msg).not.toContain('short-secret-value');
  });

  it('rejects short webhook secrets without echoing them', () => {
    const msg = problems({ ...valid, PLASMATRACK_WEBHOOK_SECRET_TEST: 'tooshort' });
    expect(msg).toContain('PLASMATRACK_WEBHOOK_SECRET_TEST');
    expect(msg).not.toContain('tooshort');
  });
});
