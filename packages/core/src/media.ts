import { RetryableError } from './interactions/types.ts';

// Downloads images the bot shows or forwards: Discord attachments (for
// /submit) and the server's signed evidence links (valid for an hour, so they
// are fetched when shown). Only https, only the hosts the caller allows.

export interface FetchedMedia {
  bytes: Uint8Array<ArrayBuffer>;
  contentType: string;
}

export interface MediaFetcher {
  get(url: string, maxBytes: number): Promise<FetchedMedia>;
}

/** Thrown for a file that isn't there or is too large: retrying won't help. */
export class MediaError extends Error {
  override name = 'MediaError';
}

/** Discord's attachment CDN. */
export const DISCORD_CDN_HOSTS = ['cdn.discordapp.com', 'media.discordapp.net'];

export interface HttpMediaFetcherOptions {
  /** Hosts allowed besides Discord's CDN (e.g. the PlasmaTrack servers). */
  extraHosts?: () => readonly string[];
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class HttpMediaFetcher implements MediaFetcher {
  private readonly options: HttpMediaFetcherOptions;
  private readonly fetchFn: typeof fetch;

  constructor(options: HttpMediaFetcherOptions = {}) {
    this.options = options;
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
  }

  async get(url: string, maxBytes: number): Promise<FetchedMedia> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new MediaError('not a URL');
    }
    const allowed = [...DISCORD_CDN_HOSTS, ...(this.options.extraHosts?.() ?? [])];
    if (parsed.protocol !== 'https:' || !allowed.includes(parsed.hostname)) throw new MediaError(`host not allowed: ${parsed.hostname}`);

    let res: Response;
    try {
      res = await this.fetchFn(parsed.toString(), { signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000) });
    } catch (err) {
      throw new RetryableError(`download failed: ${String(err)}`, 5);
    }
    if (res.status === 429 || res.status >= 500) throw new RetryableError(`download answered ${res.status}`, 5);
    if (!res.ok) throw new MediaError(`download answered ${res.status}`);
    const declared = Number(res.headers.get('Content-Length'));
    if (Number.isFinite(declared) && declared > maxBytes) throw new MediaError('file too large');
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > maxBytes) throw new MediaError('file too large');
    return { bytes, contentType: (res.headers.get('Content-Type') ?? 'application/octet-stream').split(';')[0]!.trim() };
  }
}

export type ImageType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/avif';

/** The image type from a file's first bytes (PNG, JPEG, WebP or AVIF), or null. */
export function sniffImageType(bytes: Uint8Array): ImageType | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes.length >= 12 &&
    String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!) === 'RIFF' &&
    String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!) === 'WEBP'
  ) {
    return 'image/webp';
  }
  // ISO-BMFF "ftyp" box with an AVIF brand (still or sequence), as the major
  // brand or a compatible one (e.g. "mif1" files listing "avif"), like the server.
  if (bytes.length >= 12 && String.fromCharCode(bytes[4]!, bytes[5]!, bytes[6]!, bytes[7]!) === 'ftyp') {
    const size = Math.min(((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0, bytes.length, 256);
    const brand = (o: number) => String.fromCharCode(bytes[o]!, bytes[o + 1]!, bytes[o + 2]!, bytes[o + 3]!);
    const brands = [brand(8)];
    for (let o = 16; o + 4 <= size; o += 4) brands.push(brand(o));
    if (brands.includes('avif') || brands.includes('avis')) return 'image/avif';
  }
  return null;
}
