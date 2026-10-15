import { describe, expect, it } from 'vitest';
import { RetryableError } from '../src/interactions/types.ts';
import { stripImageMetadata } from '../src/image-metadata.ts';
import { HttpMediaFetcher, MediaError, sniffImageType } from '../src/media.ts';
import { fakePng, fakeWebp } from './helpers.ts';

describe('HttpMediaFetcher', () => {
  const ok = (bytes: Uint8Array, type = 'image/png') => async () => new Response(bytes.slice(), { headers: { 'Content-Type': type } });

  it('downloads from Discord’s CDN and the allowed extra hosts only, over https', async () => {
    const f = new HttpMediaFetcher({ fetch: ok(fakePng(10)), extraHosts: () => ['plasmatrack-server.example.workers.dev'] });
    expect((await f.get('https://cdn.discordapp.com/attachments/1/2/a.png', 100)).contentType).toBe('image/png');
    expect((await f.get('https://plasmatrack-server.example.workers.dev/dl/evidence/evd_1?exp=1&sig=x', 100)).bytes.length).toBe(fakePng(10).length);
    await expect(f.get('https://evil.example/a.png', 100)).rejects.toBeInstanceOf(MediaError);
    await expect(f.get('http://cdn.discordapp.com/a.png', 100)).rejects.toBeInstanceOf(MediaError);
    await expect(f.get('not a url', 100)).rejects.toBeInstanceOf(MediaError);
  });

  it('refuses files over the limit, and retries server trouble', async () => {
    const big = new HttpMediaFetcher({ fetch: ok(fakePng(1000)) });
    await expect(big.get('https://cdn.discordapp.com/a.png', 500)).rejects.toThrow('file too large');
    const busy = new HttpMediaFetcher({ fetch: async () => new Response('', { status: 503 }) });
    await expect(busy.get('https://cdn.discordapp.com/a.png', 500)).rejects.toBeInstanceOf(RetryableError);
    const gone = new HttpMediaFetcher({ fetch: async () => new Response('', { status: 404 }) });
    await expect(gone.get('https://cdn.discordapp.com/a.png', 500)).rejects.toBeInstanceOf(MediaError);
  });

  it('recognises PNG, JPEG and WebP by their bytes', () => {
    expect(sniffImageType(fakePng())).toBe('image/png');
    expect(sniffImageType(fakeWebp())).toBe('image/webp');
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImageType(new TextEncoder().encode('%PDF-1.7'))).toBeNull();
  });
});

describe('stripImageMetadata (upload fallback when the renderer is down)', () => {
  it('drops EXIF and text chunks from a PNG and keeps the image chunks in order', () => {
    const gps = new TextEncoder().encode('GPS 51.12N 1.31E');
    const png = fakePng(200, [
      { type: 'eXIf', data: gps },
      { type: 'tEXt', data: new TextEncoder().encode('Comment\0secret') },
      { type: 'pHYs', data: new Uint8Array(9) },
    ]);
    const out = stripImageMetadata(png)!;
    const text = new TextDecoder('latin1').decode(out);
    expect(text).not.toContain('GPS');
    expect(text).not.toContain('secret');
    expect(text).toContain('IHDR');
    expect(text.indexOf('pHYs')).toBeLessThan(text.indexOf('IDAT'));
    expect(text.endsWith('IEND\0\0\0\0') || text.includes('IEND')).toBe(true);
    expect(out.length).toBe(png.length - (12 + gps.length) - (12 + 14));
  });

  it('refuses what it can’t parse', () => {
    expect(stripImageMetadata(new TextEncoder().encode('%PDF'))).toBeNull();
    expect(stripImageMetadata(fakePng(100).subarray(0, 40))).toBeNull();
  });
});
