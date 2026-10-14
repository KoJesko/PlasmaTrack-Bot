// Renderer service entry point: `npm start -w @plasmatrack/renderer`.
// Configuration: environment variables (see renderer.env.example).

import { createLogger } from '@plasmatrack/core';
import { parseRendererConfig } from './config.ts';
import { Limiter } from './limiter.ts';
import { RouteRenderer } from './route.ts';
import { createRendererServer } from './server.ts';
import type { Game } from './style.ts';
import { PMTilesFileSource, StrippingTileSource, type TileSource } from './tiles.ts';

const config = parseRendererConfig(process.env);
const logger = createLogger(undefined, [config.RENDERER_KEY]);

const tiles: Partial<Record<Game, TileSource>> = {};
for (const [game, path] of [['ets2', config.TILES_ETS2], ['ats', config.TILES_ATS]] as const) {
  if (!path) {
    logger.warn(`no basemap for ${game}: routes will be drawn on a blank background`, { game });
    continue;
  }
  const source = await PMTilesFileSource.open(path);
  tiles[game] = new StrippingTileSource(source, config.STRIP_FLAGS);
  logger.info('basemap loaded', { game, path, minZoom: source.minZoom, maxZoom: source.maxZoom });
}

const server = createRendererServer({
  key: config.RENDERER_KEY,
  routes: new RouteRenderer({ tiles, stripFlags: config.STRIP_FLAGS, logger }),
  limiter: new Limiter(config.RENDER_CONCURRENCY, config.RENDER_QUEUE_LIMIT),
  logger,
});

server.listen(config.RENDERER_PORT, config.RENDERER_HOST, () => {
  logger.info('renderer listening', { host: config.RENDERER_HOST, port: config.RENDERER_PORT });
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    logger.info('shutting down', { signal });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
