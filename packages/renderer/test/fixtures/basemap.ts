import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Feature, FeatureCollection } from 'geojson';
import GeoJSONVT from 'geojson-vt';
import { fromGeojsonVt } from 'vt-pbf';
import { writePmtiles, type FixtureTile } from './pmtiles-writer.ts';

// A synthetic "ATS" basemap shaped like truckermudgeon/maps output: one source
// layer named after the game, features distinguished by `type`, and
// `hidden` / `secret` flags. Coordinates are made up; no game data is used.

export const AREA = { west: -100, south: 35, east: -90, north: 42 } as const;

/** 1°×1° prefab boxes: one visible, one secret, one hidden. Kept clear of the test route. */
export const PREFABS = {
  visible: { lon: -95, lat: 36.5 },
  secret: { lon: -92.5, lat: 36.5 },
  hidden: { lon: -97.5, lat: 36.5 },
} as const;

function box(lon: number, lat: number, props: Record<string, unknown>): Feature {
  const h = 0.5;
  return {
    type: 'Feature',
    properties: props,
    geometry: {
      type: 'Polygon',
      coordinates: [[[lon - h, lat - h], [lon + h, lat - h], [lon + h, lat + h], [lon - h, lat + h], [lon - h, lat - h]]],
    },
  };
}

export function basemapGeoJson(): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { type: 'mapArea', secret: false, zIndex: 0 },
        geometry: {
          type: 'Polygon',
          coordinates: [[[AREA.west, AREA.south], [AREA.east, AREA.south], [AREA.east, AREA.north], [AREA.west, AREA.north], [AREA.west, AREA.south]]],
        },
      },
      box(PREFABS.visible.lon, PREFABS.visible.lat, { type: 'prefab', secret: false }),
      box(PREFABS.secret.lon, PREFABS.secret.lat, { type: 'prefab', secret: true }),
      box(PREFABS.hidden.lon, PREFABS.hidden.lat, { type: 'prefab', secret: false, hidden: true }),
      {
        type: 'Feature',
        properties: { type: 'road', roadType: 'freeway', hidden: false, secret: false },
        geometry: { type: 'LineString', coordinates: [[-99, 41], [-91, 41]] },
      },
      {
        type: 'Feature',
        properties: { type: 'road', roadType: 'local', hidden: false, secret: true },
        geometry: { type: 'LineString', coordinates: [[-99, 40.5], [-91, 40.5]] },
      },
    ],
  };
}

function lon2tile(lon: number, z: number) {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}

function lat2tile(lat: number, z: number) {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
}

export const MIN_ZOOM = 2;
export const MAX_ZOOM = 8;

/** Encodes the basemap into MVT tiles (layer "ats") for zooms MIN_ZOOM..MAX_ZOOM. */
export function basemapTiles(layerName = 'ats'): FixtureTile[] {
  const index = new GeoJSONVT(basemapGeoJson(), { maxZoom: MAX_ZOOM, indexMaxZoom: MAX_ZOOM, indexMaxPoints: 0, buffer: 64 });
  const tiles: FixtureTile[] = [];
  for (let z = MIN_ZOOM; z <= MAX_ZOOM; z++) {
    for (let x = lon2tile(AREA.west, z); x <= lon2tile(AREA.east, z); x++) {
      for (let y = lat2tile(AREA.north, z); y <= lat2tile(AREA.south, z); y++) {
        const tile = index.getTile(z, x, y);
        if (tile) tiles.push({ z, x, y, data: fromGeojsonVt({ [layerName]: tile }, { version: 2 }) });
      }
    }
  }
  return tiles;
}

/** Writes the fixture archive to a temp file and returns its path. */
export function writeBasemapFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pt-basemap-'));
  const path = join(dir, 'ats.pmtiles');
  writeFileSync(path, writePmtiles(basemapTiles(), { minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM, bounds: [AREA.west, AREA.south, AREA.east, AREA.north] }));
  return path;
}
