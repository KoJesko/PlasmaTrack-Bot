import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  CHART_PATH,
  chartRenderRequestSchema,
  COMPRESS_MAX_INPUT_BYTES,
  COMPRESS_PATH,
  ROUTE_PATH,
  routeRenderRequestSchema,
  SIGNATURE_HEADER,
  TILES_AUTH_HEADER,
  TILES_PATH,
  TIMESTAMP_HEADER,
  verifyRendererRequest,
  verifyTilesUploadToken,
  type Logger,
} from '@plasmatrack/core';
import { renderChart } from './chart.ts';
import { compressImage, UnsupportedImageError } from './image.ts';
import { Limiter, QueueFullError } from './limiter.ts';
import type { RouteRenderer } from './route.ts';

export const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** Basemaps are ~50–100 MB each. */
export const MAX_TILES_BYTES = 1024 * 1024 * 1024;

export interface ServerDeps {
  key: string;
  routes: RouteRenderer;
  limiter: Limiter;
  logger: Logger;
  nowSeconds?: () => number;
  /** Accept basemap uploads into this folder, then open them with `load`. */
  basemaps?: { dir: string; load(game: 'ets2' | 'ats', path: string): Promise<void> };
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function readBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new HttpError(413, 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const out = new Uint8Array(size);
      let offset = 0;
      for (const c of chunks) {
        out.set(c, offset);
        offset += c.length;
      }
      resolve(out);
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

/** Streams an uploaded basemap to disk (never into memory), then loads it. */
async function receiveBasemap(
  req: IncomingMessage,
  res: ServerResponse,
  game: 'ets2' | 'ats',
  key: string,
  basemaps: NonNullable<ServerDeps['basemaps']>,
  logger: Logger,
) {
  if (!(await verifyTilesUploadToken(key, game, req.headers[TILES_AUTH_HEADER.toLowerCase()] as string | undefined))) {
    req.resume();
    throw new HttpError(401, 'invalid basemap upload token');
  }
  await mkdir(basemaps.dir, { recursive: true });
  const final = join(basemaps.dir, `${game}.pmtiles`);
  const part = `${final}.part`;
  let size = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _enc, done) {
      size += chunk.length;
      done(size > MAX_TILES_BYTES ? new HttpError(413, 'basemap too large') : null, chunk);
    },
  });
  try {
    await pipeline(req, limit, createWriteStream(part));
    await rename(part, final);
    await basemaps.load(game, final);
  } catch (err) {
    await rm(part, { force: true });
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, `basemap rejected: ${err instanceof Error ? err.message : String(err)}`);
  }
  logger.info('basemap uploaded', { game, bytes: size });
  sendJson(res, 200, { ok: true, game, bytes: size });
}

export function createRendererServer(deps: ServerDeps): Server {
  const now = deps.nowSeconds ?? (() => Date.now() / 1000);

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? '/', 'http://renderer').pathname;

    if (req.method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true, basemaps: { ets2: deps.routes.hasBasemap('ets2'), ats: deps.routes.hasBasemap('ats') } });
      return;
    }
    const tilesMatch = TILES_PATH.exec(path);
    if (req.method === 'PUT' && tilesMatch && deps.basemaps) {
      await receiveBasemap(req, res, tilesMatch[1] as 'ets2' | 'ats', deps.key, deps.basemaps, deps.logger);
      return;
    }
    if (req.method !== 'POST' || (path !== ROUTE_PATH && path !== CHART_PATH && path !== COMPRESS_PATH)) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }

    const body = await readBody(req, path === COMPRESS_PATH ? COMPRESS_MAX_INPUT_BYTES : MAX_BODY_BYTES);
    // Authenticate before parsing anything.
    const ok = await verifyRendererRequest(
      deps.key,
      'POST',
      path,
      body,
      req.headers[TIMESTAMP_HEADER.toLowerCase()] as string | undefined,
      req.headers[SIGNATURE_HEADER.toLowerCase()] as string | undefined,
      now(),
    );
    if (!ok) throw new HttpError(401, 'invalid or expired signature');

    if (path === COMPRESS_PATH) {
      const started = performance.now();
      let avif: Uint8Array;
      try {
        avif = await deps.limiter.run(() => compressImage(body));
      } catch (err) {
        if (err instanceof UnsupportedImageError) throw new HttpError(400, err.message);
        throw err;
      }
      deps.logger.info('compressed', { in: body.length, out: avif.length, ms: Math.round(performance.now() - started) });
      res.writeHead(200, { 'Content-Type': 'image/avif', 'Content-Length': String(avif.length), 'Cache-Control': 'no-store' });
      res.end(avif);
      return;
    }

    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(body));
    } catch {
      throw new HttpError(400, 'body is not JSON');
    }

    const started = performance.now();
    let png: Uint8Array;
    if (path === ROUTE_PATH) {
      const parsed = routeRenderRequestSchema.safeParse(json);
      if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      png = (await deps.limiter.run(() => deps.routes.render(parsed.data))).png;
    } else {
      const parsed = chartRenderRequestSchema.safeParse(json);
      if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      png = await deps.limiter.run(async () => renderChart(parsed.data));
    }
    deps.logger.info('rendered', { path, bytes: png.length, ms: Math.round(performance.now() - started) });
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(png.length), 'Cache-Control': 'no-store' });
    res.end(png);
  };

  return createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message.slice(0, 500) });
      } else if (err instanceof QueueFullError) {
        sendJson(res, 503, { error: 'renderer is busy' }, { 'Retry-After': '5' });
      } else {
        deps.logger.error('render failed', { err });
        sendJson(res, 500, { error: 'render failed' });
      }
    });
  });
}
