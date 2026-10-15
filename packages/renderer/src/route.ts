import mbgl from '@maplibre/maplibre-gl-native';
import type { Logger, ParsedRouteRenderRequest, RouteExtra, ScaleClass } from '@plasmatrack/core';
import sharp from 'sharp';
import { fitView, type LonLat, type View } from './geo.ts';
import { legendExtent, overlaySvg, type OverlayOptions } from './overlay.ts';
import { buildStyle, type Game } from './style.ts';
import { svgToPng } from './svg.ts';
import type { TileSource } from './tiles.ts';

const PADDING = 56;
const MAX_ZOOM = 16;
const TILE_URL = /^pt:\/\/(ets2|ats)\/(\d+)\/(\d+)\/(\d+)$/;
// MapLibre's ResourceKind.Tile (a const enum in its typings).
const KIND_TILE = 3;

export interface RouteRendererOptions {
  tiles: Partial<Record<Game, TileSource>>;
  stripFlags: readonly string[];
  logger: Logger;
}

export interface RenderedRoute {
  png: Uint8Array;
  view: View;
}

export class RouteRenderer {
  private readonly options: RouteRendererOptions;

  constructor(options: RouteRendererOptions) {
    this.options = options;
  }

  hasBasemap(game: Game): boolean {
    return this.options.tiles[game] !== undefined;
  }

  /** Swaps in a basemap (e.g. one uploaded at start-up); later renders use it. */
  setBasemap(game: Game, tiles: TileSource): void {
    this.options.tiles[game] = tiles;
  }

  async render(req: ParsedRouteRenderRequest): Promise<RenderedRoute> {
    const tiles = this.options.tiles[req.game];
    const points: LonLat[] = req.route.features.flatMap((f) => f.geometry.coordinates.map((c) => [c[0]!, c[1]!] as const));
    const { classes, extras } = legendEntries(req);
    const overlayOptions: OverlayOptions = {
      width: req.width,
      height: req.height,
      game: req.game,
      classes,
      extras,
      ...(req.legend ? { legend: req.legend } : {}),
      ...(req.title ? { title: req.title } : {}),
    };
    const view = fitClearOfLegend(points, req.width, req.height, legendExtent(overlayOptions));

    const style = buildStyle({
      game: req.game,
      basemap: tiles ? { minzoom: tiles.minZoom, maxzoom: tiles.maxZoom } : null,
      route: req.route,
      stripFlags: this.options.stripFlags,
    });

    const raw = await this.renderMap(style, view, tiles);
    const overlay = svgToPng(overlaySvg(overlayOptions));
    const png = await sharp(raw, { raw: { width: req.width, height: req.height, channels: 4 } })
      .composite([{ input: Buffer.from(overlay) }])
      .png({ compressionLevel: 9 })
      .toBuffer();
    return { png: new Uint8Array(png), view };
  }

  private renderMap(style: object, view: View, tiles: TileSource | undefined): Promise<Uint8Array> {
    const logger = this.options.logger;
    const map = new mbgl.Map({
      ratio: 1,
      request: (req, callback) => {
        const m = TILE_URL.exec(req.url);
        if (req.kind !== KIND_TILE || !m || !tiles) {
          callback(new Error(`unsupported resource ${req.url}`));
          return;
        }
        tiles
          .getTile(Number(m[2]), Number(m[3]), Number(m[4]))
          .then((data) => (data ? callback(undefined, { data }) : callback()))
          .catch((err: unknown) => {
            // A broken tile leaves a hole rather than failing the whole image.
            logger.warn('tile read failed', { url: req.url, err });
            callback();
          });
      },
    });
    return new Promise((resolve, reject) => {
      try {
        map.load(style);
        map.render({ zoom: view.zoom, center: view.center, width: view.width, height: view.height }, (err, buffer) => {
          map.release();
          if (err || !buffer) reject(err ?? new Error('render produced no image'));
          else resolve(buffer);
        });
      } catch (err) {
        map.release();
        reject(err);
      }
    });
  }
}

/** What the legend lists: only what is actually drawn. */
export function legendEntries(req: ParsedRouteRenderRequest): { classes: Set<ScaleClass>; extras: Set<RouteExtra> } {
  const classes = new Set<ScaleClass>();
  const extras = new Set<RouteExtra>();
  for (const { properties: p } of req.route.features) {
    if (p.status === 'reverted') {
      extras.add('reverted');
      continue;
    }
    if (p.segment === 'driving') {
      classes.add(p.scale_class);
      if (!p.counted) extras.add('uncounted');
    } else if (p.segment === 'ferry' || p.segment === 'train') extras.add('ferry_train');
    else extras.add(p.segment);
  }
  return { classes, extras };
}

/**
 * Fits the route beside or below the legend (top-left), whichever leaves it
 * bigger, so the legend never hides part of the route.
 */
export function fitClearOfLegend(
  points: LonLat[],
  width: number,
  height: number,
  legend: { right: number; bottom: number },
): View {
  const zoom = { min: 0, max: MAX_ZOOM };
  const below = fitView(points, width, height, { top: legend.bottom + 12, right: PADDING, bottom: PADDING, left: PADDING }, zoom);
  const beside = fitView(points, width, height, { top: PADDING, right: PADDING, bottom: PADDING, left: legend.right + 12 }, zoom);
  return below.zoom >= beside.zoom ? below : beside;
}
