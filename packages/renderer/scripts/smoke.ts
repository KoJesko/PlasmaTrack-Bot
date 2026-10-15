// Smoke test for a running renderer (used by .github/workflows/renderer-image.yml
// against the freshly built image): draws a route, a chart and a bar chart, and shrinks an
// image to AVIF, through the bot's own signed client.
//
// Usage: RENDERER_URL=http://127.0.0.1:8788 RENDERER_KEY=... node packages/renderer/scripts/smoke.ts

import { MemoryBlobCache, RendererClient, sniffImageType } from '@plasmatrack/core';

const baseUrl = process.env['RENDERER_URL'];
const key = process.env['RENDERER_KEY'];
if (!baseUrl || !key) {
  console.error('set RENDERER_URL and RENDERER_KEY');
  process.exit(2);
}

const client = new RendererClient({ baseUrl, key, cache: new MemoryBlobCache(), timeoutMs: 60_000 });

const map = await client.renderRoute({
  game: 'ats',
  width: 600,
  height: 400,
  route: {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: { scale_class: 'road' }, geometry: { type: 'LineString', coordinates: [[-100, 35], [-99, 36]] } }],
  },
});
const chart = await client.renderChart({ title: 'Speed', unit: 'mph', points: [[0, 10], [60, 55], [120, 40]] });
const bars = await client.renderBars({ title: 'Distance per week', unit: 'mi', labels: ['W40', 'W41', 'W42'], values: [120, null, 80] });
const avif = await client.compressImage(chart.bytes, 'image/png');

const checks = [
  ['route map is a PNG', sniffImageType(map.bytes) === 'image/png'],
  ['chart is a PNG', sniffImageType(chart.bytes) === 'image/png'],
  ['bar chart is a PNG', sniffImageType(bars.bytes) === 'image/png'],
  ['compressed image is AVIF', sniffImageType(avif.bytes) === 'image/avif'],
] as const;
for (const [name, ok] of checks) console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
console.log(`sizes: map ${map.bytes.length} B, chart ${chart.bytes.length} B → AVIF ${avif.bytes.length} B`);
if (checks.some(([, ok]) => !ok)) process.exit(1);
