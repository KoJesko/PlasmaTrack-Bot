import { describe, expect, it } from 'vitest';
import { utf8 } from '../src/bytes.ts';
import { RetryableError } from '../src/interactions/types.ts';
import { MemoryBlobCache } from '../src/memory.ts';
import { RendererClient } from '../src/render/client.ts';
import {
  ROUTE_PATH,
  routeRenderRequestSchema,
  signRendererRequest,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verifyRendererRequest,
  type RouteRenderRequest,
} from '../src/render/protocol.ts';
import { FakeClock } from './helpers.ts';

const KEY = 'renderer-test-key-0123456789abcdef0123';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const request: RouteRenderRequest = {
  game: 'ats',
  route: {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { scale_class: 'road', local_scale: 20 }, geometry: { type: 'LineString', coordinates: [[-100, 35], [-99, 36]] } },
    ],
  },
};

describe('route request schema', () => {
  it('draws unrecognised or missing scale classes as unknown, and never derives one from local_scale', () => {
    const parsed = routeRenderRequestSchema.parse({
      game: 'ets2',
      route: {
        type: 'FeatureCollection',
        features: [
          { type: 'Feature', properties: { scale_class: 'weird', local_scale: 19 }, geometry: { type: 'LineString', coordinates: [[1, 2], [3, 4]] } },
          { type: 'Feature', properties: null, geometry: { type: 'LineString', coordinates: [[1, 2], [3, 4]] } },
          { type: 'Feature', properties: { local_scale: 1 }, geometry: { type: 'LineString', coordinates: [[1, 2], [3, 4]] } },
        ],
      },
    });
    expect(parsed.route.features.map((f) => f.properties.scale_class)).toEqual(['unknown', 'unknown', 'unknown']);
    expect(parsed.width).toBe(1200);
  });

  it('rejects mixed games, bad coordinates and oversize routes', () => {
    expect(routeRenderRequestSchema.safeParse({ ...request, game: 'both' }).success).toBe(false);
    const bad = structuredClone(request);
    bad.route.features[0]!.geometry.coordinates = [[200, 0], [0, 0]];
    expect(routeRenderRequestSchema.safeParse(bad).success).toBe(false);
    const huge = structuredClone(request);
    huge.route.features[0]!.geometry.coordinates = Array.from({ length: 100_001 }, (_, i) => [0, (i % 80) as number]);
    expect(routeRenderRequestSchema.safeParse(huge).success).toBe(false);
  });
});

describe('renderer request signing', () => {
  const body = utf8('{"a":1}');

  it('verifies its own signatures', async () => {
    const h = await signRendererRequest(KEY, 'POST', ROUTE_PATH, body, 1_800_000_000);
    expect(await verifyRendererRequest(KEY, 'POST', ROUTE_PATH, body, h[TIMESTAMP_HEADER], h[SIGNATURE_HEADER], 1_800_000_010)).toBe(true);
  });

  it('rejects a wrong key, body, path, stale or future timestamp, and malformed headers', async () => {
    const h = await signRendererRequest(KEY, 'POST', ROUTE_PATH, body, 1_800_000_000);
    const ts = h[TIMESTAMP_HEADER]!;
    const sig = h[SIGNATURE_HEADER]!;
    const now = 1_800_000_000;
    expect(await verifyRendererRequest('another-key-0123456789abcdef0123456', 'POST', ROUTE_PATH, body, ts, sig, now)).toBe(false);
    expect(await verifyRendererRequest(KEY, 'POST', ROUTE_PATH, utf8('{"a":2}'), ts, sig, now)).toBe(false);
    expect(await verifyRendererRequest(KEY, 'POST', '/v1/render/chart', body, ts, sig, now)).toBe(false);
    expect(await verifyRendererRequest(KEY, 'POST', ROUTE_PATH, body, ts, sig, now + 301)).toBe(false);
    expect(await verifyRendererRequest(KEY, 'POST', ROUTE_PATH, body, ts, sig, now - 301)).toBe(false);
    expect(await verifyRendererRequest(KEY, 'POST', ROUTE_PATH, body, ts, sig.toUpperCase(), now)).toBe(false);
    expect(await verifyRendererRequest(KEY, 'POST', ROUTE_PATH, body, null, sig, now)).toBe(false);
  });
});

describe('RendererClient', () => {
  function client(respond: () => Response | Promise<Response>) {
    const calls: { url: string; init: RequestInit }[] = [];
    const cache = new MemoryBlobCache();
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return respond();
    }) as unknown as typeof fetch;
    const clock = new FakeClock();
    return { c: new RendererClient({ baseUrl: 'https://renderer.test', key: KEY, cache, fetch: fetchFn, clock }), calls, cache, clock };
  }

  it('signs the request, caches the PNG and serves repeats from the cache', async () => {
    const { c, calls, cache, clock } = client(() => new Response(PNG, { headers: { 'Content-Type': 'image/png' } }));
    const first = await c.renderRoute(request);
    expect(first.cached).toBe(false);
    expect([...first.bytes]).toEqual([...PNG]);
    expect(calls[0]!.url).toBe('https://renderer.test/v1/render/route');

    const headers = calls[0]!.init.headers as Record<string, string>;
    const ok = await verifyRendererRequest(KEY, 'POST', ROUTE_PATH, calls[0]!.init.body as Uint8Array<ArrayBuffer>, headers[TIMESTAMP_HEADER], headers[SIGNATURE_HEADER], clock.now() / 1000);
    expect(ok).toBe(true);

    const second = await c.renderRoute(structuredClone(request));
    expect(second.cached).toBe(true);
    expect(calls).toHaveLength(1);
    expect([...cache.blobs.keys()][0]).toMatch(/^route\/v1\/[0-9a-f]{64}\.png$/);
  });

  it('turns outages into retryable errors and rejections into plain errors', async () => {
    await expect(client(() => new Response('busy', { status: 503, headers: { 'Retry-After': '7' } })).c.renderRoute(request)).rejects.toMatchObject({
      name: 'RetryableError',
      delaySeconds: 7,
    });
    await expect(
      client(() => {
        throw new TypeError('fetch failed');
      }).c.renderRoute(request),
    ).rejects.toBeInstanceOf(RetryableError);
    const rejected = await client(() => new Response('bad signature', { status: 401 })).c.renderRoute(request).catch((e) => e);
    expect(rejected).not.toBeInstanceOf(RetryableError);
    await expect(client(() => new Response('not a png')).c.renderRoute(request)).rejects.toThrow(/not a PNG/);
  });
});
