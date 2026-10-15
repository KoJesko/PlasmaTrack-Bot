import { TILES_AUTH_HEADER, tilesUploadToken } from '@plasmatrack/core';
import { describe, expect, it } from 'vitest';
import { RENDERER_IDLE_MS, RENDERER_PORT, RendererGate, type ContainerLike } from '../src/renderer-container.ts';

const KEY = 'renderer-test-key-0123456789abcdef0123';

/** A container that becomes healthy after `bootPolls` health checks and remembers what it got. */
class FakeContainer implements ContainerLike {
  running = false;
  starts: Record<string, string>[] = [];
  idle: number[] = [];
  uploads: { game: string; bytes: number; auth: string | null }[] = [];
  requests: string[] = [];
  private polls = 0;
  readonly bootPolls: number;
  basemaps: Record<string, boolean> = { ets2: false, ats: false };

  constructor(bootPolls = 2) {
    this.bootPolls = bootPolls;
  }

  start(options: { enableInternet: boolean; env?: Record<string, string> }) {
    if (this.running) throw new Error('already running');
    expect(options.enableInternet).toBe(false);
    this.running = true;
    this.polls = 0;
    this.basemaps = { ets2: false, ats: false };
    this.starts.push(options.env ?? {});
  }

  async setInactivityTimeout(ms: number) {
    this.idle.push(ms);
  }

  getTcpPort(port: number) {
    expect(port).toBe(RENDERER_PORT);
    return {
      fetch: async (req: Request) => {
        const path = new URL(req.url).pathname;
        if (path === '/healthz') {
          if (++this.polls < this.bootPolls) throw new Error('connection refused');
          return Response.json({ ok: true, basemaps: this.basemaps });
        }
        const tiles = /^\/v1\/tiles\/(\w+)$/.exec(path);
        if (tiles && req.method === 'PUT') {
          const bytes = (await req.arrayBuffer()).byteLength;
          this.uploads.push({ game: tiles[1]!, bytes, auth: req.headers.get(TILES_AUTH_HEADER) });
          this.basemaps[tiles[1]!] = true;
          return Response.json({ ok: true });
        }
        this.requests.push(`${req.method} ${path}`);
        return new Response('png', { headers: { 'Content-Type': 'image/png' } });
      },
    };
  }
}

const tiles = {
  get: async (key: string) =>
    key === 'ets2.pmtiles' || key === 'ats.pmtiles'
      ? ({ size: 5, body: new Response(new Uint8Array([1, 2, 3, 4, 5])).body! } as unknown as R2ObjectBody)
      : null,
};

const render = () => new Request('http://renderer.internal/v1/render/route', { method: 'POST', body: '{}' });

describe('RendererGate', () => {
  it('starts the container once, uploads both basemaps, sets the 30 s idle timer, then forwards', async () => {
    const c = new FakeContainer();
    const gate = new RendererGate(c, { RENDERER_KEY: KEY, TILES: tiles }, async () => {});
    const [a, b] = await Promise.all([gate.fetch(render()), gate.fetch(render())]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(c.starts).toHaveLength(1);
    expect(c.starts[0]).toMatchObject({ RENDERER_KEY: KEY, RENDERER_HOST: '0.0.0.0', RENDERER_PORT: '8788', RENDER_CONCURRENCY: '1' });
    expect(c.idle).toEqual([RENDERER_IDLE_MS]);
    expect(RENDERER_IDLE_MS).toBe(30_000);
    expect(c.uploads.map((u) => [u.game, u.bytes])).toEqual([
      ['ets2', 5],
      ['ats', 5],
    ]);
    expect(c.uploads[0]!.auth).toBe(await tilesUploadToken(KEY, 'ets2'));
    expect(c.requests).toEqual(['POST /v1/render/route', 'POST /v1/render/route']);

    // Still running: no new start, no new uploads.
    await gate.fetch(render());
    expect(c.starts).toHaveLength(1);
    expect(c.uploads).toHaveLength(2);
  });

  it('starts again after the container stopped (idle timeout), with fresh basemaps', async () => {
    const c = new FakeContainer(1);
    const gate = new RendererGate(c, { RENDERER_KEY: KEY, TILES: tiles }, async () => {});
    await gate.fetch(render());
    c.running = false;
    await gate.fetch(render());
    expect(c.starts).toHaveLength(2);
    expect(c.uploads).toHaveLength(4);
  });

  it('answers 503 with Retry-After when the container never becomes healthy, and tries again next time', async () => {
    const c = new FakeContainer(Number.POSITIVE_INFINITY);
    let now = Date.now();
    const realNow = Date.now;
    Date.now = () => now;
    try {
      const gate = new RendererGate(c, { RENDERER_KEY: KEY }, async (ms) => {
        now += ms * 100; // time flies
      });
      const res = await gate.fetch(render());
      expect(res.status).toBe(503);
      expect(res.headers.get('Retry-After')).toBe('10');
      expect(c.requests).toEqual([]);
    } finally {
      Date.now = realNow;
    }
  });

  it('works without a TILES bucket (maps without a background)', async () => {
    const c = new FakeContainer(1);
    const gate = new RendererGate(c, { RENDERER_KEY: KEY }, async () => {});
    expect((await gate.fetch(render())).status).toBe(200);
    expect(c.uploads).toEqual([]);
  });
});
