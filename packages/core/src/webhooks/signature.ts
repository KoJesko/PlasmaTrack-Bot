import { bytesToHex, hexToBytes, timingSafeEqual, utf8 } from '../bytes.ts';

// Server → bot webhook signature (server WEBHOOKS §2):
//   X-PlasmaTrack-Signature: t=<unix seconds>,v1=<hex>[,v1=<hex>]
// v1 = HMAC-SHA256(secret, "{t}.{raw body}"), lowercase hex. During a secret
// rotation the server sends one v1 per secret; any match is accepted.

export const WEBHOOK_SIGNATURE_HEADER = 'X-PlasmaTrack-Signature';
export const WEBHOOK_EVENT_HEADER = 'X-PlasmaTrack-Event';
export const WEBHOOK_EVENT_ID_HEADER = 'X-PlasmaTrack-Event-Id';
export const WEBHOOK_TOLERANCE_SECONDS = 300;
/** Server WEBHOOKS §3: request bodies are at most 256 KiB. */
export const WEBHOOK_MAX_BYTES = 256 * 1024;

export interface ParsedSignature {
  timestamp: string;
  signatures: Uint8Array[];
}

export function parseSignatureHeader(header: string | null | undefined): ParsedSignature | null {
  if (!header || header.length > 1024) return null;
  let timestamp: string | undefined;
  const signatures: Uint8Array[] = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (key === 't' && /^\d{1,12}$/.test(value)) timestamp = value;
    else if (key === 'v1' && /^[0-9a-f]{64}$/.test(value)) signatures.push(hexToBytes(value)!);
  }
  return timestamp && signatures.length > 0 ? { timestamp, signatures } : null;
}

async function mac(secret: string, timestamp: string, body: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', utf8(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const prefix = utf8(`${timestamp}.`);
  // Sign the exact bytes received: never re-encode the body.
  const message = new Uint8Array(prefix.length + body.length);
  message.set(prefix, 0);
  message.set(body, prefix.length);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, message));
}

export async function verifyWebhookSignature(
  secrets: readonly string[],
  header: string | null | undefined,
  body: Uint8Array,
  nowSeconds: number,
): Promise<boolean> {
  const parsed = parseSignatureHeader(header);
  if (!parsed || secrets.length === 0) return false;
  if (Math.abs(nowSeconds - Number(parsed.timestamp)) > WEBHOOK_TOLERANCE_SECONDS) return false;
  let ok = false;
  for (const secret of secrets) {
    const expected = await mac(secret, parsed.timestamp, body);
    // Compare against every candidate, without stopping early.
    for (const sig of parsed.signatures) ok = timingSafeEqual(expected, sig) || ok;
  }
  return ok;
}

/** How the server signs; used by tests and the mock server. */
export async function signWebhook(secrets: readonly string[], body: Uint8Array, nowSeconds: number): Promise<string> {
  const t = String(Math.floor(nowSeconds));
  const parts = [`t=${t}`];
  for (const s of secrets) parts.push(`v1=${bytesToHex(await mac(s, t, body))}`);
  return parts.join(',');
}
