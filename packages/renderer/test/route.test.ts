import { createLogger, MAP_CREDIT_LINE, routeRenderRequestSchema, type RouteRenderRequest } from '@plasmatrack/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { toPixel, type LonLat } from '../src/geo.ts';
import { overlaySvg } from '../src/overlay.ts';
import { legendEntries, RouteRenderer } from '../src/route.ts';
import { COLORS, EXTRA_STYLES, SCALE_COLORS } from '../src/style.ts';
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

  it('draws crossings, teleports, gaps, uncounted and reverted stretches apart from counted driving', async () => {
    const seg = (props: Record<string, unknown>, from: LonLat, to: LonLat) => ({
      ...line('road', from, to),
      properties: { scale_class: 'road', ...props },
    });
    const req = routeRenderRequestSchema.parse({
      game: 'ats',
      width: 800,
      height: 600,
      route: {
        type: 'FeatureCollection',
        features: [
          seg({ counted: false }, [-99, 39], [-97, 39]),
          seg({}, [-96, 39], [-94, 39]),
          seg({ segment: 'ferry', scale_class: 'unknown' }, [-93, 39], [-91, 39]),
          seg({ segment: 'teleport', scale_class: 'unknown' }, [-99, 38], [-97, 38]),
          seg({ segment: 'something_new', scale_class: 'unknown' }, [-96, 38], [-94, 38]),
          seg({ status: 'reverted' }, [-93, 38], [-91, 38]),
          seg({}, [-99.5, 35.5], [-99.4, 35.5]),
          seg({}, [-90.5, 41.8], [-90.4, 41.8]),
        ],
      },
    });
    const { png, view } = await renderer.render(req);
    const img = await decodePng(png);
    const at = (p: LonLat) => img.pixel(...toPixel(view, p));
    // Thin lines can fall between pixel rows: look one row either side too.
    const seen = (from: number, to: number, lat: number, color: string, tolerance = 12) => {
      let n = 0;
      for (let lon = from; lon <= to; lon += 0.02) {
        const [x, y] = toPixel(view, [lon, lat]);
        if ([-1, 0, 1].some((dy) => near(img.pixel(x, y + dy), hex(color), tolerance))) n++;
      }
      return n;
    };

    expect(at([-95, 39])).toSatisfy((c: number[]) => near(c, hex(SCALE_COLORS.road)));
    // Uncounted: faded, so never the full road colour.
    expect(seen(-98.8, -97.2, 39, SCALE_COLORS.road, 8)).toBe(0);
    expect(at([-98, 39])).not.toSatisfy((c: number[]) => near(c, hex(COLORS.mapArea), 3));
    expect(seen(-92.8, -91.2, 39, EXTRA_STYLES.ferry_train.color)).toBeGreaterThan(10);
    expect(seen(-98.8, -97.2, 38, EXTRA_STYLES.teleport.color)).toBeGreaterThan(5);
    // An unknown segment kind is drawn as missing data.
    expect(seen(-95.8, -94.2, 38, EXTRA_STYLES.gap.color)).toBeGreaterThan(5);
    expect(seen(-92.8, -91.2, 38, EXTRA_STYLES.reverted.color)).toBeGreaterThan(5);
    expect(seen(-92.8, -91.2, 38, SCALE_COLORS.road, 8)).toBe(0);

    expect(legendEntries(req)).toEqual({
      classes: new Set(['road']),
      extras: new Set(['uncounted', 'ferry_train', 'teleport', 'gap', 'reverted']),
    });
  });

  it('legend shows the extra kinds only when present', () => {
    const svg = overlaySvg({ width: 800, height: 600, game: 'ets2', classes: new Set(['road']), extras: new Set(['ferry_train']) });
    expect(svg).toContain('Ferry or train');
    expect(svg).not.toContain('Missing data');
    expect(svg).not.toContain('save load');
  });

  it('lists only the classes present, with server-provided text, and escapes it', () => {
    const svg = overlaySvg({ width: 800, height: 600, game: 'ets2', classes: new Set(['road', 'unknown']), legend: { road: '<b>&' } });
    expect(svg).toContain('Euro Truck Simulator 2');
    expect(svg).toContain('Road scale (vanilla): &lt;b&gt;&amp;');
    expect(svg).toContain('Scale not reported');
    expect(svg).not.toContain('1:1');
  });
});
