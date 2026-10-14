import { hexToBytes, utf8 } from '../bytes.ts';

/**
 * Checks Discord's Ed25519 signature on an interaction request.
 * Discord signs `timestamp + raw body` with the application's key
 * (headers `X-Signature-Ed25519` and `X-Signature-Timestamp`).
 */
export async function verifyDiscordSignature(
  publicKeyHex: string,
  signatureHex: string | null,
  timestamp: string | null,
  rawBody: string,
): Promise<boolean> {
  if (!signatureHex || !timestamp) return false;
  const publicKey = hexToBytes(publicKeyHex);
  const signature = hexToBytes(signatureHex);
  if (!publicKey || publicKey.length !== 32 || !signature || signature.length !== 64) {
    return false;
  }
  try {
    const key = await crypto.subtle.importKey('raw', publicKey, { name: 'Ed25519' }, false, [
      'verify',
    ]);
    return await crypto.subtle.verify('Ed25519', key, signature, utf8(timestamp + rawBody));
  } catch {
    return false;
  }
}
