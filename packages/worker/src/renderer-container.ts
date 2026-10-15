import { DurableObject } from 'cloudflare:workers';
import { TILES_AUTH_HEADER, tilesUploadToken } from '@plasmatrack/core';
import type { Env } from './env.ts';

// The renderer (packages/renderer, MapLibre Native + sharp) runs as a
// Cloudflare Container behind this Durable Object. The bot reaches it only
// through the RENDERER binding: it has no public address.
//
// On the first request after it stopped, the container is started, waited
// for, and given the basemaps from the private TILES bucket (they are not in
// the image). It stops 30 s after the last request (owner, 2026-10-15: images
// aren't urgent), so most maps start it cold; requests wait for that.

export const RENDERER_PORT = 8788;
export const RENDERER_IDLE_MS = 30_000;
const START_TIMEOUT_MS = 90_000;
const GAMES = ['ets2', 'ats'] as const;

/** The parts of `ctx.container` used here; faked in tests. */
export interface ContainerLike {
  readonly running: boolean;
  start(options: { enableInternet: boolean; env?: Record<string, string> }): void;
  getTcpPort(port: number): { fetch(request: Request): Promise<Response> };
  setInactivityTimeout(durationMs: number): Promise<void>;
}

export interface GateEnv {
  RENDERER_KEY: string;
  TILES?: Pick<R2Bucket, 'get'>;
}

/** Starts the container when needed and forwards requests to it. */
export class RendererGate {
  private readonly container: ContainerLike;
  private readonly env: GateEnv;
  private readonly sleep: (ms: number) => Promise<void>;
  private ready: Promise<void> | null = null;

  constructor(container: ContainerLike, env: GateEnv, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))) {
    this.container = container;
    this.env = env;
    this.sleep = sleep;
  }

  async fetch(request: Request): Promise<Response> {
    try {
      await this.ensureReady();
    } catch (err) {
      this.ready = null;
      console.error(JSON.stringify({ level: 'error', msg: 'renderer container failed to start', err: err instanceof Error ? err.message : String(err) }));
      return Response.json({ error: 'renderer is starting or unavailable' }, { status: 503, headers: { 'Retry-After': '10' } });
    }
    const url = new URL(request.url);
    return this.port().fetch(new Request(`http://renderer${url.pathname}${url.search}`, request));
  }

  private port() {
    return this.container.getTcpPort(RENDERER_PORT);
  }

  private ensureReady(): Promise<void> {
    // A container that stopped (idle timeout, crash) needs a fresh start.
    if (!this.container.running) this.ready = null;
    this.ready ??= this.boot();
    return this.ready;
  }

  private async boot(): Promise<void> {
    if (!this.container.running) {
      this.container.start({
        enableInternet: false,
        env: {
          RENDERER_KEY: this.env.RENDERER_KEY,
          RENDERER_HOST: '0.0.0.0',
          RENDERER_PORT: String(RENDERER_PORT),
          // A quarter vCPU: one render at a time, the rest wait their turn.
          RENDER_CONCURRENCY: '1',
          RENDER_QUEUE_LIMIT: '16',
          TILES_DIR: '/tmp/tiles',
        },
      });
    }
    await this.container.setInactivityTimeout(RENDERER_IDLE_MS);
    const health = await this.waitForHealth();
    for (const game of GAMES) {
      if (!health.basemaps?.[game]) await this.uploadBasemap(game);
    }
  }

  private async waitForHealth(): Promise<{ basemaps?: Record<string, boolean> }> {
    const deadline = Date.now() + START_TIMEOUT_MS;
    let lastError = 'not started';
    while (Date.now() < deadline) {
      try {
        const res = await this.port().fetch(new Request('http://renderer/healthz'));
        if (res.ok) return (await res.json()) as { basemaps?: Record<string, boolean> };
        lastError = `healthz answered ${res.status}`;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
      await this.sleep(250);
    }
    throw new Error(`renderer did not become healthy: ${lastError}`);
  }

  /** Streams `{game}.pmtiles` from R2 into the container. Without it, that game's maps have no background. */
  private async uploadBasemap(game: (typeof GAMES)[number]): Promise<void> {
    const object = await this.env.TILES?.get(`${game}.pmtiles`);
    if (!object) {
      console.warn(JSON.stringify({ level: 'warn', msg: 'no basemap in the TILES bucket', game }));
      return;
    }
    const res = await this.port().fetch(
      new Request(`http://renderer/v1/tiles/${game}`, {
        method: 'PUT',
        headers: { [TILES_AUTH_HEADER]: await tilesUploadToken(this.env.RENDERER_KEY, game), 'Content-Length': String(object.size) },
        body: object.body,
      }),
    );
    if (!res.ok) throw new Error(`basemap upload for ${game} answered ${res.status}`);
  }
}

export class RendererContainer extends DurableObject<Env> {
  private gate: RendererGate | null = null;

  override async fetch(request: Request): Promise<Response> {
    const container = this.ctx.container;
    if (!container) return new Response('no container is configured for this Durable Object', { status: 503 });
    this.gate ??= new RendererGate(container as unknown as ContainerLike, this.env);
    return this.gate.fetch(request);
  }
}
