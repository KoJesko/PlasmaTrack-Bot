import { describe, expect, it } from 'vitest';
import { ConfigError, parseBotConfig, secretValues } from '../src/config.ts';

const valid = {
  DISCORD_APPLICATION_ID: '100000000000000001',
  DISCORD_PUBLIC_KEY: 'a'.repeat(64),
  DISCORD_BOT_TOKEN: 'MTAwMDAwMDAwMDAwMDAwMDAx.secret-bot-token',
  DISCORD_GUILD_ID: '200000000000000002',
  MODERATOR_ROLE_IDS: '300000000000000003, 300000000000000004',
  RENDERER_URL: 'https://renderer.example.org',
  RENDERER_KEY: 'k'.repeat(40),
};

describe('parseBotConfig', () => {
  it('parses a complete environment and applies defaults', () => {
    const cfg = parseBotConfig(valid);
    expect(cfg.MODERATOR_ROLE_IDS).toEqual(['300000000000000003', '300000000000000004']);
    expect(cfg.NOTICE_TTL_DAYS).toBe(30);
    expect(secretValues(cfg)).toEqual([valid.DISCORD_BOT_TOKEN, valid.RENDERER_KEY]);
  });

  it('names missing or invalid keys without echoing any value', () => {
    const env = { ...valid, DISCORD_BOT_TOKEN: undefined, RENDERER_KEY: 'short-secret-value', MODERATOR_ROLE_IDS: 'nope' };
    let message = '';
    try {
      parseBotConfig(env);
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      message = (e as Error).message;
    }
    expect(message).toContain('DISCORD_BOT_TOKEN');
    expect(message).toContain('RENDERER_KEY');
    expect(message).toContain('MODERATOR_ROLE_IDS');
    expect(message).not.toContain('short-secret-value');
  });
});
