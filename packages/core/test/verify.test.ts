import { describe, expect, it } from 'vitest';
import { bytesToHex, utf8 } from '../src/bytes.ts';
import { verifyDiscordSignature } from '../src/discord/verify.ts';

async function keypair() {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const publicHex = bytesToHex(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
  const sign = async (msg: string) =>
    bytesToHex(new Uint8Array(await crypto.subtle.sign('Ed25519', pair.privateKey, utf8(msg))));
  return { publicHex, sign };
}

describe('verifyDiscordSignature', () => {
  it('accepts a correct signature over timestamp + body', async () => {
    const { publicHex, sign } = await keypair();
    const body = '{"type":1}';
    const sig = await sign('1727520000' + body);
    expect(await verifyDiscordSignature(publicHex, sig, '1727520000', body)).toBe(true);
  });

  it('rejects a tampered body, a different timestamp or another key', async () => {
    const { publicHex, sign } = await keypair();
    const other = await keypair();
    const sig = await sign('1727520000{"type":1}');
    expect(await verifyDiscordSignature(publicHex, sig, '1727520000', '{"type":2}')).toBe(false);
    expect(await verifyDiscordSignature(publicHex, sig, '1727520001', '{"type":1}')).toBe(false);
    expect(await verifyDiscordSignature(other.publicHex, sig, '1727520000', '{"type":1}')).toBe(false);
  });

  it('rejects missing headers and malformed hex without throwing', async () => {
    const { publicHex, sign } = await keypair();
    const sig = await sign('1{}');
    expect(await verifyDiscordSignature(publicHex, null, '1', '{}')).toBe(false);
    expect(await verifyDiscordSignature(publicHex, sig, null, '{}')).toBe(false);
    expect(await verifyDiscordSignature(publicHex, 'zz' + sig.slice(2), '1', '{}')).toBe(false);
    expect(await verifyDiscordSignature(publicHex, sig.slice(0, 64), '1', '{}')).toBe(false);
    expect(await verifyDiscordSignature('abcd', sig, '1', '{}')).toBe(false);
  });
});
