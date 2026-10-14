import type { AddressInfo } from 'node:net';
import {
  chartRenderRequestSchema,
  createLogger,
  MemoryBlobCache,
  RendererClient,
  ROUTE_PATH,
  signRendererRequest,
} from '@plasmatrack/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chartSvg, downsample, formatDuration, niceTicks, renderChart, timeTicks } from '../src/chart.ts';
import { Limiter, QueueFullError } from '../src/limiter.ts';
import { RouteRenderer } from '../src/route.ts';
import { createRendererServer } from '../src/server.ts';
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
