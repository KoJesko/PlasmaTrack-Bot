import type { RouteGeoJson, ScaleClass } from '@plasmatrack/core';

// Our own MapLibre style for basemap tiles produced by truckermudgeon/maps.
// It only relies on documented facts about those tiles: one source layer named
// after the game ("ets2" / "ats"), features told apart by a `type` property
// (road, prefab, mapArea, ferry, ...), and `hidden` / `secret` flags. No styles
// or code from that project are used.

export type Game = 'ets2' | 'ats';

/** Route colours by scale class (decided 2026-09-28): city grey, road blue, 1:1 orange, non-standard red, unknown dashed. */
export const SCALE_COLORS: Record<ScaleClass, string> = {
  city: '#8a8a8a',
  road: '#1f6feb',
  one_to_one: '#f28c28',
  nonstandard: '#d62828',
  unknown: '#3b3b3b',
};

export const UNKNOWN_DASH: [number, number] = [2, 1.5];
export const ROUTE_WIDTH = 5;
export const ROUTE_CASING_WIDTH = 9;

export const COLORS = {
  background: '#f2efe9',
  mapArea: '#e2ded4',
  prefab: '#d8d3c8',
  roadCasing: '#c4bdae',
  road: '#ffffff',
  ferry: '#7aa7c7',
  routeCasing: '#ffffff',
};

export interface StyleOptions {
  game: Game;
  /** Zoom range of the basemap archive, or null when no basemap is configured. */
  basemap: { minzoom: number; maxzoom: number } | null;
  route: RouteGeoJson;
  stripFlags: readonly string[];
}

export function tileUrlTemplate(game: Game): string {
  return `pt://${game}/{z}/{x}/{y}`;
}

export function buildStyle(opts: StyleOptions): object {
  // Second line of defence: tiles are already stripped in StrippingTileSource.
  const notFlagged = opts.stripFlags.map((f) => ['!', ['to-boolean', ['get', f]]]);
  const ofType = (type: string) => ['all', ['==', ['get', 'type'], type], ...notFlagged];
  const sourceLayer = opts.game;

  const basemapLayers = opts.basemap
    ? [
        { id: 'map-areas', type: 'fill', source: 'basemap', 'source-layer': sourceLayer, filter: ofType('mapArea'), paint: { 'fill-color': COLORS.mapArea } },
        { id: 'prefabs', type: 'fill', source: 'basemap', 'source-layer': sourceLayer, filter: ofType('prefab'), paint: { 'fill-color': COLORS.prefab } },
        {
          id: 'roads-casing',
          type: 'line',
          source: 'basemap',
          'source-layer': sourceLayer,
          filter: ofType('road'),
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': COLORS.roadCasing, 'line-width': ['interpolate', ['linear'], ['zoom'], 4, 1, 9, 3, 14, 10] },
        },
        {
          id: 'roads',
          type: 'line',
          source: 'basemap',
          'source-layer': sourceLayer,
          filter: ofType('road'),
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': COLORS.road, 'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.5, 9, 1.8, 14, 7] },
        },
        {
          id: 'ferries',
          type: 'line',
          source: 'basemap',
          'source-layer': sourceLayer,
          filter: ofType('ferry'),
          paint: { 'line-color': COLORS.ferry, 'line-width': 1.5, 'line-dasharray': [3, 2] },
        },
      ]
    : [];

  return {
    version: 8,
    sources: {
      ...(opts.basemap
        ? {
            basemap: {
              type: 'vector',
              tiles: [tileUrlTemplate(opts.game)],
              minzoom: opts.basemap.minzoom,
              maxzoom: opts.basemap.maxzoom,
            },
          }
        : {}),
      route: { type: 'geojson', data: opts.route },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': COLORS.background } },
      ...basemapLayers,
      {
        id: 'route-casing',
        type: 'line',
        source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': COLORS.routeCasing, 'line-width': ROUTE_CASING_WIDTH },
      },
      {
        id: 'route',
        type: 'line',
        source: 'route',
        filter: ['!=', ['get', 'scale_class'], 'unknown'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': [
            'match',
            ['get', 'scale_class'],
            'city', SCALE_COLORS.city,
            'road', SCALE_COLORS.road,
            'one_to_one', SCALE_COLORS.one_to_one,
            'nonstandard', SCALE_COLORS.nonstandard,
            SCALE_COLORS.unknown,
          ],
          'line-width': ROUTE_WIDTH,
        },
      },
      {
        id: 'route-unknown',
        type: 'line',
        source: 'route',
        filter: ['==', ['get', 'scale_class'], 'unknown'],
        layout: { 'line-join': 'round' },
        paint: { 'line-color': SCALE_COLORS.unknown, 'line-width': ROUTE_WIDTH, 'line-dasharray': UNKNOWN_DASH },
      },
    ],
  };
}
