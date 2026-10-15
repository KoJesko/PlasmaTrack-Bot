import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  chartRenderRequestSchema,
  createLogger,
  ImageRejectedError,
  MemoryBlobCache,
  RendererClient,
  ROUTE_PATH,
  signRendererRequest,
  stripImageMetadata,
  TILES_AUTH_HEADER,
  tilesUploadToken,
} from '@plasmatrack/core';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chartSvg, downsample, formatDuration, niceTicks, renderChart, timeTicks } from '../src/chart.ts';
import { Limiter, QueueFullError } from '../src/limiter.ts';
import { RouteRenderer } from '../src/route.ts';
import { createRendererServer } from '../src/server.ts';
import { PMTilesFileSource } from '../src/tiles.ts';
import { writeBasemapFixture } from './fixtures/basemap.ts';
import { decodePng } from './helpers.ts';

const KEY = 'renderer-test-key-0123456789abcdef0123';
const logger = createLogger(() => {});

describe('charts', () => {
  it('keeps one-sample spikes when downsampling', () => {
    const points: [number, number | null][] = Array.from({ length: 10_000 }, (_, i) => [i, 60]);
    points[5_000] = [5_000, 140];
    const out = downsample(points, 500, 10_000);
    expect(out.length).toBeLessThanOrEqual(1_000);
    expect(Math.max(...out.map((p) => p[1] ?? 0))).toBe(140);
  });

  it('breaks the line at gaps', () => {
    const svg = chartSvg(chartRenderRequestSchema.parse({ title: 'Speed', unit: 'mph', points: [[0, 50], [10, 55], [20, null], [30, 60], [40, 62]] }));
    expect(svg.match(/[ML]/g)?.filter((c) => c === 'M').length).toBeGreaterThanOrEqual(2);
  });

  it('formats axes', () => {
    expect(niceTicks(0, 100, 5)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(timeTicks(3000, 8)).toEqual([0, 600, 1200, 1800, 2400, 3000]);
    expect(timeTicks(40_000, 8)).toEqual([0, 7200, 14400, 21600, 28800, 36000]);
    expect(formatDuration(75)).toBe('1:15');
    expect(formatDuration(3_725)).toBe('1:02:05');
  });

  it('draws thresholds, bands and markers, escaping labels', async () => {
    const req = chartRenderRequestSchema.parse({
      title: 'Speed — job <42>',
      unit: 'mph',
      width: 900,
      height: 400,
      points: Array.from({ length: 600 }, (_, i) => [i * 5, 55 + 20 * Math.sin(i / 30)]),
      thresholds: [{ value: 75, label: 'Penalty' }, { value: 105, label: 'Invalid' }],
      bands: [{ from: 600, to: 900, kind: 'reverted' }, { from: 1500, to: 1700, kind: 'ferry' }],
      markers: [{ t: 2000, label: 'Fuel jump' }],
    });
    const svg = chartSvg(req);
    for (const s of ['Penalty', 'Invalid', 'Reverted', 'Ferry', 'Fuel jump', 'job &lt;42&gt;']) expect(svg).toContain(s);
    const img = await decodePng(renderChart(req));
    expect([img.width, img.height]).toEqual([900, 400]);
  });
});

describe('limiter', () => {
  it('refuses work beyond the queue limit', async () => {
    const limiter = new Limiter(1, 0);
    let release!: () => void;
    const first = limiter.run(() => new Promise<void>((r) => (release = r)));
    await expect(limiter.run(async () => 1)).rejects.toBeInstanceOf(QueueFullError);
    release();
    await first;
    expect(await limiter.run(async () => 2)).toBe(2);
  });
});

describe('renderer HTTP service', () => {
  let base: string;
  const server = createRendererServer({
    key: KEY,
    routes: new RouteRenderer({ tiles: {}, stripFlags: ['hidden', 'secret'], logger }),
    limiter: new Limiter(2, 4),
    logger,
  });

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const route = {
    game: 'ats' as const,
    width: 400,
    height: 300,
    route: {
      type: 'FeatureCollection' as const,
      features: [{ type: 'Feature' as const, properties: { scale_class: 'road' }, geometry: { type: 'LineString' as const, coordinates: [[-100, 35], [-99, 36]] as [number, number][] } }],
    },
  };

  it('serves a health check listing configured basemaps', async () => {
    const res = await fetch(`${base}/healthz`);
    expect(await res.json()).toEqual({ ok: true, basemaps: { ets2: false, ats: false } });
  });

  it('renders routes and charts for the bot’s own client (signed end to end)', async () => {
    const client = new RendererClient({ baseUrl: base, key: KEY, cache: new MemoryBlobCache() });
    const map = await client.renderRoute(route);
    expect((await decodePng(map.bytes)).width).toBe(400);
    const chart = await client.renderChart({ title: 'Fuel', unit: 'L', points: [[0, 400], [60, 380]] });
    expect((await decodePng(chart.bytes)).height).toBe(500);
    const bars = await client.renderBars({ title: 'Distance per week', unit: 'mi', labels: ['W41', 'W42'], values: [10, 20], height: 300 });
    expect((await decodePng(bars.bytes)).height).toBe(300);
  });

  it('compresses evidence images to AVIF: at most 1920 px, metadata (GPS) removed', async () => {
    const client = new RendererClient({ baseUrl: base, key: KEY, cache: new MemoryBlobCache() });
    const jpeg = new Uint8Array(
      await sharp({ create: { width: 3840, height: 2160, channels: 3, background: '#4a7' } })
        .jpeg()
        .withExif({ IFD0: { Make: 'TestCam' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '51/1 7/1 0/1' } })
        .toBuffer(),
    );
    expect((await sharp(jpeg).metadata()).exif).toBeDefined();
    const out = await client.compressImage(jpeg, 'image/jpeg');
    const meta = await sharp(out.bytes).metadata();
    expect(meta.format).toBe('heif');
    expect(meta.compression).toBe('av1');
    expect([meta.width, meta.height]).toEqual([1920, 1080]);
    expect(meta.exif).toBeUndefined();
    // Small images are not enlarged.
    const small = new Uint8Array(await sharp({ create: { width: 200, height: 100, channels: 3, background: '#000' } }).png().toBuffer());
    expect((await sharp((await client.compressImage(small, 'image/png')).bytes).metadata()).width).toBe(200);
  });

  it('re-compresses AVIF uploads too (shrinks them; never passes them through)', async () => {
    const client = new RendererClient({ baseUrl: base, key: KEY, cache: new MemoryBlobCache() });
    const bigAvif = new Uint8Array(
      await sharp({ create: { width: 4000, height: 3000, channels: 3, background: '#357' } })
        .avif({ quality: 100, effort: 0 })
        .withExif({ IFD0: { Make: 'TestCam' } })
        .toBuffer(),
    );
    const out = await client.compressImage(bigAvif, 'image/avif');
    const meta = await sharp(out.bytes).metadata();
    expect([meta.width, meta.height]).toEqual([1920, 1440]);
    expect(meta.exif).toBeUndefined();
    expect(out.contentType).toBe('image/avif');
  });

  it('the bot’s fallback strips EXIF/GPS from real JPEG and WebP files, which still decode', async () => {
    const exif = { IFD0: { Make: 'TestCam' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '51/1 7/1 0/1' } };
    const img = sharp({ create: { width: 64, height: 32, channels: 3, background: '#4a7' } });
    for (const input of [await img.clone().jpeg().withExif(exif).toBuffer(), await img.clone().webp().withExif(exif).toBuffer()]) {
      expect((await sharp(input).metadata()).exif).toBeDefined();
      const out = stripImageMetadata(new Uint8Array(input))!;
      const meta = await sharp(out).metadata();
      expect(meta.exif).toBeUndefined();
      expect([meta.width, meta.height]).toEqual([64, 32]);
      await sharp(out).raw().toBuffer(); // the pixels are intact
    }
  });

  it('accepts a basemap upload only with the key-derived token, streams it to disk and loads it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pt-tiles-'));
    const loaded: string[] = [];
    const routes = new RouteRenderer({ tiles: {}, stripFlags: ['hidden', 'secret'], logger });
    const up = createRendererServer({
      key: KEY,
      routes,
      limiter: new Limiter(1, 1),
      logger,
      basemaps: {
        dir,
        async load(game, path) {
          loaded.push(`${game}:${path}`);
          routes.setBasemap(game, await PMTilesFileSource.open(path));
        },
      },
    });
    await new Promise<void>((resolve) => up.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(up.address() as AddressInfo).port}/v1/tiles/ats`;
    try {
      const body = readFileSync(writeBasemapFixture());
      expect((await fetch(url, { method: 'PUT', body })).status).toBe(401);
      expect((await fetch(url, { method: 'PUT', body, headers: { [TILES_AUTH_HEADER]: await tilesUploadToken(KEY, 'ets2') } })).status).toBe(401);
      const ok = await fetch(url, { method: 'PUT', body, headers: { [TILES_AUTH_HEADER]: await tilesUploadToken(KEY, 'ats') } });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ ok: true, game: 'ats', bytes: body.length });
      expect(loaded).toEqual([`ats:${join(dir, 'ats.pmtiles')}`]);
      expect(routes.hasBasemap('ats')).toBe(true);
      // Something that isn't a basemap is refused and leaves nothing behind.
      const bad = await fetch(url.replace('ats', 'ets2'), { method: 'PUT', body: 'not tiles', headers: { [TILES_AUTH_HEADER]: await tilesUploadToken(KEY, 'ets2') } });
      expect(bad.status).toBe(400);
      expect(routes.hasBasemap('ets2')).toBe(false);
      expect(readdirSync(dir).sort()).toEqual(['ats.pmtiles', 'ets2.pmtiles']);
    } finally {
      await new Promise<void>((resolve) => up.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses something that is not an image, so the bot can tell the player', async () => {
    const client = new RendererClient({ baseUrl: base, key: KEY, cache: new MemoryBlobCache() });
    await expect(client.compressImage(new TextEncoder().encode('not an image at all'), 'image/png')).rejects.toBeInstanceOf(ImageRejectedError);
  });

  it('rejects unsigned, wrongly signed and stale requests with 401', async () => {
    const body = new TextEncoder().encode(JSON.stringify(route));
    expect((await fetch(base + ROUTE_PATH, { method: 'POST', body })).status).toBe(401);
    const wrong = await signRendererRequest('wrong-key-0123456789abcdef0123456789', 'POST', ROUTE_PATH, body, Date.now() / 1000);
    expect((await fetch(base + ROUTE_PATH, { method: 'POST', body, headers: wrong })).status).toBe(401);
    const stale = await signRendererRequest(KEY, 'POST', ROUTE_PATH, body, Date.now() / 1000 - 3600);
    expect((await fetch(base + ROUTE_PATH, { method: 'POST', body, headers: stale })).status).toBe(401);
  });

  it('answers 400 for a signed but invalid request', async () => {
    const body = new TextEncoder().encode(JSON.stringify({ ...route, game: 'both' }));
    const headers = await signRendererRequest(KEY, 'POST', ROUTE_PATH, body, Date.now() / 1000);
    const res = await fetch(base + ROUTE_PATH, { method: 'POST', body, headers });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('game');
  });

  it('answers 503 with Retry-After when busy', async () => {
    let release!: () => void;
    const slow = createRendererServer({
      key: KEY,
      routes: { hasBasemap: () => false, render: () => new Promise((r) => (release = () => r({ png: new Uint8Array([1]), view: { center: [0, 0], zoom: 0, width: 1, height: 1 } }))) } as unknown as RouteRenderer,
      limiter: new Limiter(1, 0),
      logger,
    });
    await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(slow.address() as AddressInfo).port}${ROUTE_PATH}`;
    const send = async () => {
      const body = new TextEncoder().encode(JSON.stringify(route));
      return fetch(url, { method: 'POST', body, headers: await signRendererRequest(KEY, 'POST', ROUTE_PATH, body, Date.now() / 1000) });
    };
    const first = send();
    await new Promise((r) => setTimeout(r, 100));
    const busy = await send();
    expect(busy.status).toBe(503);
    expect(busy.headers.get('Retry-After')).toBe('5');
    release();
    expect((await first).status).toBe(200);
    await new Promise<void>((resolve) => slow.close(() => resolve()));
  });
});
