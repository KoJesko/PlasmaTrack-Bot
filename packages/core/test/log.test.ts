import { describe, expect, it } from 'vitest';
import { createLogger, REDACTED } from '../src/log.ts';

function logger(secrets: string[] = []) {
  const lines: string[] = [];
  return { log: createLogger((_l, line) => lines.push(line), secrets), lines };
}

describe('logger redaction', () => {
  it('masks fields whose names look like credentials, at any depth', () => {
    const { log, lines } = logger();
    log.info('x', { token: 'abc', nested: { Authorization: 'Bot xyz', playerToken: 'p' }, ok: 1 });
    const entry = JSON.parse(lines[0]!);
    expect(entry.token).toBe(REDACTED);
    expect(entry.nested.Authorization).toBe(REDACTED);
    expect(entry.nested.playerToken).toBe(REDACTED);
    expect(entry.ok).toBe(1);
  });

  it('masks registered secret values inside any string, message or error', () => {
    const secret = 'MTAwMDAwMDAwMDAwMDAwMDAx.bot-token-value';
    const { log, lines } = logger([secret]);
    const player = 'pt_live_0123456789abcdef0123456789abcdef';
    log.addSecret(player);
    log.error(`failed with ${secret}`, { detail: `sent ${player}`, err: new Error(`boom ${secret}`) });
    const out = lines.join('\n');
    expect(out).not.toContain(secret);
    expect(out).not.toContain(player);
    expect(out).toContain(REDACTED);
  });

  it('masks interaction tokens in webhook URLs', () => {
    const { log, lines } = logger();
    log.warn('edit failed', { url: 'https://discord.com/api/v10/webhooks/100000000000000001/aW50ZXJhY3Rpb24.abc-def/messages/@original' });
    expect(lines[0]).not.toContain('aW50ZXJhY3Rpb24');
    expect(lines[0]).toContain(`/webhooks/100000000000000001/${REDACTED}`);
  });
});
