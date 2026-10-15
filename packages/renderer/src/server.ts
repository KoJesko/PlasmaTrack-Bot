import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  CHART_PATH,
  chartRenderRequestSchema,
  COMPRESS_MAX_INPUT_BYTES,
  COMPRESS_PATH,
  ROUTE_PATH,
  routeRenderRequestSchema,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verifyRendererRequest,
  type Logger,
} from '@plasmatrack/core';
import { renderChart } from './chart.ts';
import { compressImage, UnsupportedImageError } from './image.ts';
import { Limiter, QueueFullError } from './limiter.ts';
import type { RouteRenderer } from './route.ts';

export const MAX_BODY_BYTES = 8 * 1024 * 1024;

export interface ServerDeps {
  key: string;
  routes: RouteRenderer;
  limiter: Limiter;
  logger: Logger;
  nowSeconds?: () => number;
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

export function createRendererServer(deps: ServerDeps): Server {
  const now = deps.nowSeconds ?? (() => Date.now() / 1000);

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? '/', 'http://renderer').pathname;

    if (req.method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true, basemaps: { ets2: deps.routes.hasBasemap('ets2'), ats: deps.routes.hasBasemap('ats') } });
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
      let webp: Uint8Array;
      try {
        webp = await deps.limiter.run(() => compressImage(body));
      } catch (err) {
        if (err instanceof UnsupportedImageError) throw new HttpError(400, err.message);
        throw err;
      }
      deps.logger.info('compressed', { in: body.length, out: webp.length, ms: Math.round(performance.now() - started) });
      res.writeHead(200, { 'Content-Type': 'image/webp', 'Content-Length': String(webp.length), 'Cache-Control': 'no-store' });
      res.end(webp);
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
