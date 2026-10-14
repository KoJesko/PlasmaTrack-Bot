import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { describe, expect, it } from 'vitest';
import { isFlagged, PMTilesFileSource, StrippingTileSource, stripFlaggedFeatures } from '../src/tiles.ts';
import { basemapTiles, MAX_ZOOM, MIN_ZOOM, writeBasemapFixture } from './fixtures/basemap.ts';

function features(bytes: Uint8Array) {
  const layer = new VectorTile(new PbfReader(bytes)).layers['ats']!;
  return Array.from({ length: layer.length }, (_, i) => layer.feature(i).properties);
}

describe('tile stripping', () => {
  it('treats true-ish flag values as flagged and everything else as visible', () => {
    for (const v of [true, 1, 'true', '1']) expect(isFlagged({ secret: v }, ['hidden', 'secret'])).toBe(true);
    for (const v of [false, 0, 'false', null, undefined]) expect(isFlagged({ secret: v }, ['hidden', 'secret'])).toBe(false);
  });

  it('removes hidden and secret features and keeps the rest', () => {
    // z5/7/12 covers all three prefab boxes and the secret road.
    const tile = basemapTiles().find((t) => t.z === 5 && t.x === 7 && t.y === 12)!;
    const before = features(tile.data);
    expect(before.some((p) => p['secret'] === true)).toBe(true);
    expect(before.some((p) => p['hidden'] === true)).toBe(true);

    const after = features(stripFlaggedFeatures(tile.data, ['hidden', 'secret']));
    expect(after.some((p) => p['secret'] === true || p['hidden'] === true)).toBe(false);
    expect(after.filter((p) => p['type'] === 'prefab')).toHaveLength(1);
    expect(after.filter((p) => p['type'] === 'mapArea')).toHaveLength(1);
  });

  it('reads a PMTiles archive from disk and strips through the wrapper', async () => {
    const source = await PMTilesFileSource.open(writeBasemapFixture());
    expect([source.minZoom, source.maxZoom]).toEqual([MIN_ZOOM, MAX_ZOOM]);
    const stripped = new StrippingTileSource(source, ['hidden', 'secret']);
    const [z, x, y] = [5, 7, 12]; // covers the fixture area
    const raw = await source.getTile(z, x, y);
    expect(raw).not.toBeNull();
    expect(features(raw!).length).toBeGreaterThan(features((await stripped.getTile(z, x, y))!).length);
    expect(await source.getTile(5, 0, 0)).toBeNull();
    await source.close();
  });
});
