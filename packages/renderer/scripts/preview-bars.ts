// Writes sample labelled charts to a folder, to look at them by eye.
// Usage: node packages/renderer/scripts/preview-bars.ts <output folder>

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { barsRenderRequestSchema } from '@plasmatrack/core';
import { renderBars } from '../src/bars.ts';

const out = process.argv[2];
if (!out) {
  console.error('give an output folder');
  process.exit(2);
}
mkdirSync(out, { recursive: true });

const weeks = Array.from({ length: 12 }, (_, i) => `W${31 + i}`);
const samples = {
  columns: { title: 'Example Driver · ETS2 · distance in game per week', unit: 'mi', labels: weeks, values: [120, 0, 340, 80, null, 410, 220, 0, 95, 610, 300, 78] },
  income: { title: 'Example Driver · ETS2 · income per week', unit: '€', labels: weeks, values: [4200, -800, 12000, 3100, 0, 15800, 9000, 0, 2500, 21000, 11000, 4210] },
  line: { title: 'Example Driver · ATS · fuel used (running total)', unit: 'gal', kind: 'line', labels: weeks, values: [10, 10, 42, 51, 51, 90, 112, 112, 121, 180, 207, 215] },
  days: { title: 'Example Driver · ETS2 · distance at 1:1 per day', unit: 'mi', labels: Array.from({ length: 30 }, (_, i) => `Oct ${i + 1}`), values: Array.from({ length: 30 }, (_, i) => (i % 3 === 0 ? 0 : 5 + ((i * 7) % 13))) },
  rows: {
    title: 'ETS2 · fuel used · all-time',
    unit: 'L',
    kind: 'rows',
    height: 80 + 6 * 34,
    labels: ['Alice', 'Bob', 'Cara', 'Example Driver', 'WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW', 'Zed'],
    values: [8200, 6100, 3900, 2210, 900, 41.2],
    value_labels: ['8,200 L', '6,100 L', '3,900 L', '2,210 L', '900 L', '41.2 L'],
  },
};
for (const [name, req] of Object.entries(samples)) {
  writeFileSync(join(out, `${name}.png`), renderBars(barsRenderRequestSchema.parse(req)));
}
console.log(`wrote ${Object.keys(samples).length} charts to ${out}`);
