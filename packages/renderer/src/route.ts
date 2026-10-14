import mbgl from '@maplibre/maplibre-gl-native';
import type { Logger, ParsedRouteRenderRequest, ScaleClass } from '@plasmatrack/core';
import sharp from 'sharp';
import { fitView, type LonLat, type View } from './geo.ts';
import { overlaySvg } from './overlay.ts';
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

  async render(req: ParsedRouteRenderRequest): Promise<RenderedRoute> {
    const tiles = this.options.tiles[req.game];
    const points: LonLat[] = req.route.features.flatMap((f) => f.geometry.coordinates.map((c) => [c[0]!, c[1]!] as const));
    const view = fitView(points, req.width, req.height, PADDING, { min: 0, max: MAX_ZOOM });

    const style = buildStyle({
      game: req.game,
      basemap: tiles ? { minzoom: tiles.minZoom, maxzoom: tiles.maxZoom } : null,
      route: req.route,
      stripFlags: this.options.stripFlags,
    });

    const raw = await this.renderMap(style, view, tiles);
    const classes = new Set<ScaleClass>(req.route.features.map((f) => f.properties.scale_class));
    const overlay = svgToPng(
      overlaySvg({
        width: req.width,
        height: req.height,
        game: req.game,
        classes,
        ...(req.legend ? { legend: req.legend } : {}),
        ...(req.title ? { title: req.title } : {}),
      }),
    );
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
