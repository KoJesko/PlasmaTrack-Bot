import { createLogger, MAP_CREDIT_LINE, routeRenderRequestSchema, type RouteRenderRequest } from '@plasmatrack/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { toPixel, type LonLat } from '../src/geo.ts';
import { overlaySvg } from '../src/overlay.ts';
import { RouteRenderer } from '../src/route.ts';
import { COLORS, SCALE_COLORS } from '../src/style.ts';
import { PMTilesFileSource, StrippingTileSource } from '../src/tiles.ts';
import { PREFABS, writeBasemapFixture } from './fixtures/basemap.ts';
import { decodePng, hex, near, type Image } from './helpers.ts';

const logger = createLogger(() => {});

const line = (scale_class: string, from: LonLat, to: LonLat) => ({
  type: 'Feature' as const,
  properties: { scale_class },
  geometry: { type: 'LineString' as const, coordinates: [[from[0], from[1]], [to[0], to[1]]] as [number, number][] },
});

// Each class on its own stretch, away from the prefab boxes; two tiny
// segments at the corners stretch the view over the whole fixture area.
const ROUTE: RouteRenderRequest = {
  game: 'ats',
  width: 800,
  height: 600,
  route: {
    type: 'FeatureCollection',
    features: [
      line('city', [-99, 39], [-97, 39]),
      line('road', [-96, 39], [-94, 39]),
      line('one_to_one', [-93, 39], [-91, 39]),
      line('nonstandard', [-99, 38], [-97, 38]),
      line('unknown', [-96, 38], [-91, 38]),
      line('road', [-99.5, 35.5], [-99.4, 35.5]),
      line('road', [-90.5, 41.8], [-90.4, 41.8]),
    ],
  },
  legend: { road: '12.3 mi', one_to_one: '0.4 mi' },
};

let renderer: RouteRenderer;
let image: Image;
let px: (p: LonLat) => [number, number, number];

beforeAll(async () => {
  const source = await PMTilesFileSource.open(writeBasemapFixture());
  renderer = new RouteRenderer({ tiles: { ats: new StrippingTileSource(source, ['hidden', 'secret']) }, stripFlags: ['hidden', 'secret'], logger });
  const { png, view } = await renderer.render(routeRenderRequestSchema.parse(ROUTE));
  image = await decodePng(png);
  px = (p) => image.pixel(...toPixel(view, p));
});

describe('route image', () => {
  it('has the requested size', () => {
    expect([image.width, image.height]).toEqual([800, 600]);
  });

  it('colours each stretch by the scale class the server sent', () => {
    expect(px([-98, 39])).toSatisfy((c: number[]) => near(c, hex(SCALE_COLORS.city)));
    expect(px([-95, 39])).toSatisfy((c: number[]) => near(c, hex(SCALE_COLORS.road)));
    expect(px([-92, 39])).toSatisfy((c: number[]) => near(c, hex(SCALE_COLORS.one_to_one)));
    expect(px([-98, 38])).toSatisfy((c: number[]) => near(c, hex(SCALE_COLORS.nonstandard)));
  });

  it('draws unknown scale as a dashed line', () => {
    let dash = 0;
    let gap = 0;
    for (let lon = -95.5; lon <= -91.5; lon += 0.02) {
      const c = px([lon, 38]);
      if (near(c, hex(SCALE_COLORS.unknown), 20)) dash++;
      else if (near(c, hex(COLORS.routeCasing), 20)) gap++;
    }
    expect(dash).toBeGreaterThan(20);
    expect(gap).toBeGreaterThan(20);
  });

  it('draws the basemap but strips hidden and secret features', () => {
    expect(px([PREFABS.visible.lon, PREFABS.visible.lat])).toSatisfy((c: number[]) => near(c, hex(COLORS.prefab), 3));
    expect(px([PREFABS.secret.lon, PREFABS.secret.lat])).toSatisfy((c: number[]) => near(c, hex(COLORS.mapArea), 3));
    expect(px([PREFABS.hidden.lon, PREFABS.hidden.lat])).toSatisfy((c: number[]) => near(c, hex(COLORS.mapArea), 3));
  });

  it('burns the credits line into the bottom-right corner', () => {
    let dark = 0;
    for (let x = image.width - 300; x < image.width - 8; x++) {
      for (let y = image.height - 17; y < image.height - 6; y++) if (Math.max(...image.pixel(x, y)) < 110) dark++;
    }
    expect(dark).toBeGreaterThan(50);
    expect(overlaySvg({ width: 800, height: 600, game: 'ats', classes: new Set() })).toContain(
      MAP_CREDIT_LINE.replace('&', '&amp;'),
    );
  });

  it('still draws a route that does not line up with the vanilla map', async () => {
    const misaligned: RouteRenderRequest = {
      game: 'ats',
      width: 640,
      height: 480,
      route: { type: 'FeatureCollection', features: [line('one_to_one', [150, -40], [152, -39])] },
    };
    const { png, view } = await renderer.render(routeRenderRequestSchema.parse(misaligned));
    const img = await decodePng(png);
    expect(img.pixel(...toPixel(view, [151, -39.5]))).toSatisfy((c: number[]) => near(c, hex(SCALE_COLORS.one_to_one)));
    expect(img.pixel(600, 200)).toSatisfy((c: number[]) => near(c, hex(COLORS.background), 3));
  });

  it('renders without a basemap configured', async () => {
    const bare = new RouteRenderer({ tiles: {}, stripFlags: ['hidden', 'secret'], logger });
    const { png } = await bare.render(routeRenderRequestSchema.parse({ ...ROUTE, game: 'ets2' }));
    expect((await decodePng(png)).width).toBe(800);
  });

  it('lists only the classes present, with server-provided text, and escapes it', () => {
    const svg = overlaySvg({ width: 800, height: 600, game: 'ets2', classes: new Set(['road', 'unknown']), legend: { road: '<b>&' } });
    expect(svg).toContain('Euro Truck Simulator 2');
    expect(svg).toContain('Road scale (vanilla): &lt;b&gt;&amp;');
    expect(svg).toContain('Scale not reported');
    expect(svg).not.toContain('1:1');
  });
});
