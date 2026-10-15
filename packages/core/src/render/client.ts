import { canonicalJson, sha256Hex, utf8 } from '../bytes.ts';
import { RetryableError } from '../interactions/types.ts';
import { sniffImageType } from '../media.ts';
import type { BlobCache, CachedBlob, Clock } from '../ports.ts';
import { systemClock } from '../ports.ts';
import {
  CHART_PATH,
  chartRenderRequestSchema,
  COMPRESS_PATH,
  RENDER_PROTOCOL_VERSION,
  ROUTE_PATH,
  routeRenderRequestSchema,
  signRendererRequest,
  type ChartRenderRequest,
  type RouteRenderRequest,
} from './protocol.ts';

export interface RenderedImage extends CachedBlob {
  cached: boolean;
}

/** What tasks use to get images. Implemented by `RendererClient`; faked in tests. */
export interface ImageRenderer {
  renderRoute(request: RouteRenderRequest): Promise<RenderedImage>;
  renderChart(request: ChartRenderRequest): Promise<RenderedImage>;
}

/** Shrinks evidence images before they are uploaded (the renderer does it with sharp). */
export interface ImageCompressor {
  /** WebP, at most 1920 px on the long side, metadata (e.g. GPS) removed. */
  compressImage(bytes: Uint8Array<ArrayBuffer>, contentType: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; contentType: 'image/webp' }>;
}

/** The renderer could read the request but not the image: retrying won't help. */
export class ImageRejectedError extends Error {
  override name = 'ImageRejectedError';
}

export interface RendererClientOptions {
  baseUrl: string;
  key: string;
  cache: BlobCache;
  fetch?: typeof fetch;
  clock?: Clock;
  /** Per request; keep well under the queue consumer's limits. */
  timeoutMs?: number;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

/**
 * Fetches PNGs from the external renderer service, signed with the shared key,
 * and caches them by a hash of the request. Nothing is rendered in the Worker.
 */
export class RendererClient implements ImageRenderer, ImageCompressor {
  private readonly options: RendererClientOptions;
  private readonly fetchFn: typeof fetch;
  private readonly clock: Clock;

  constructor(options: RendererClientOptions) {
    this.options = options;
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
    this.clock = options.clock ?? systemClock;
  }

  renderRoute(request: RouteRenderRequest): Promise<RenderedImage> {
    return this.render(ROUTE_PATH, 'route', routeRenderRequestSchema.parse(request));
  }

  renderChart(request: ChartRenderRequest): Promise<RenderedImage> {
    return this.render(CHART_PATH, 'chart', chartRenderRequestSchema.parse(request));
  }

  async compressImage(bytes: Uint8Array<ArrayBuffer>, contentType: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; contentType: 'image/webp' }> {
    const headers = {
      'Content-Type': contentType,
      ...(await signRendererRequest(this.options.key, 'POST', COMPRESS_PATH, bytes, this.clock.now() / 1000)),
    };
    let res: Response;
    try {
      res = await this.fetchFn(new URL(COMPRESS_PATH, this.options.baseUrl).toString(), {
        method: 'POST',
        headers,
        body: bytes,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 25_000),
      });
    } catch (err) {
      throw new RetryableError(`renderer unreachable: ${String(err)}`, 10);
    }
    if (res.status === 429 || res.status >= 500) throw new RetryableError(`renderer answered ${res.status}`, 10);
    if (res.status === 400 || res.status === 413 || res.status === 415) throw new ImageRejectedError(`renderer rejected the image (${res.status})`);
    if (!res.ok) throw new Error(`renderer rejected the compress request (${res.status})`);
    const out = new Uint8Array(await res.arrayBuffer());
    if (sniffImageType(out) !== 'image/webp') throw new Error('renderer returned something that is not WebP');
    return { bytes: out, contentType: 'image/webp' };
  }

  private async render(path: string, kind: string, request: unknown): Promise<RenderedImage> {
    const json = canonicalJson(request);
    const key = `${kind}/v${RENDER_PROTOCOL_VERSION}/${await sha256Hex(json)}.png`;
    const hit = await this.options.cache.get(key);
    if (hit) return { ...hit, cached: true };

    const body = utf8(json);
    const headers = {
      'Content-Type': 'application/json',
      ...(await signRendererRequest(this.options.key, 'POST', path, body, this.clock.now() / 1000)),
    };
    let res: Response;
    try {
      res = await this.fetchFn(new URL(path, this.options.baseUrl).toString(), {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 25_000),
      });
    } catch (err) {
      throw new RetryableError(`renderer unreachable: ${String(err)}`, 10);
    }
    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get('Retry-After'));
      throw new RetryableError(`renderer answered ${res.status}`, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 10);
    }
    if (!res.ok) {
      // 4xx means we sent something the renderer rejects: a bug or a key mismatch, not worth retrying.
      throw new Error(`renderer rejected the ${kind} request (${res.status}): ${(await res.text()).slice(0, 200)}`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!PNG_MAGIC.every((b, i) => bytes[i] === b)) throw new Error('renderer returned something that is not a PNG');

    const blob: CachedBlob = { bytes, contentType: 'image/png' };
    await this.options.cache.put(key, blob);
    return { ...blob, cached: false };
  }
}
