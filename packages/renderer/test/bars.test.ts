import { barsRenderRequestSchema } from '@plasmatrack/core';
import { describe, expect, it } from 'vitest';
import { barsSvg, fitText, formatTick, renderBars } from '../src/bars.ts';
import { decodePng, hex, near } from './helpers.ts';

const parse = (r: unknown) => barsRenderRequestSchema.parse(r);
const rects = (svg: string, color: string) => svg.match(new RegExp(`<rect [^>]*fill="${color}"`, 'g'))?.length ?? 0;

describe('labelled charts', () => {
  it('draws one column per value, negatives in red below zero, and nothing for null', () => {
    const svg = barsSvg(parse({ title: 'Income per week', unit: '€', labels: ['W40', 'W41', 'W42', 'W43'], values: [1200, -300, null, 0] }));
    expect(rects(svg, '#1f6feb')).toBe(2); // 1200 and the flat 0
    expect(rects(svg, '#d62828')).toBe(1);
    expect(svg).toContain('>W41<');
  });

  it('draws a running total as one line, broken at null', () => {
    const svg = barsSvg(parse({ title: 'Total', unit: 'mi', kind: 'line', labels: ['a', 'b', 'c', 'd'], values: [1, 2, null, 4] }));
    const path = /<path d="([^"]+)"/.exec(svg)![1]!;
    expect(path.match(/M/g)).toHaveLength(2);
    expect(svg.match(/<circle /g)).toHaveLength(3);
  });

  it('thins x labels so they never overlap', () => {
    const labels = Array.from({ length: 365 }, (_, i) => `2026-${String(Math.floor(i / 31) + 1).padStart(2, '0')}-${String((i % 31) + 1).padStart(2, '0')}`);
    const svg = barsSvg(parse({ title: 'Distance per day', unit: 'mi', labels, values: labels.map((_, i) => i % 7) }));
    const shown = svg.match(/>2026-\d\d-\d\d</g)!.length;
    expect(shown).toBeGreaterThan(5);
    expect(shown).toBeLessThan(40);
  });

  it('draws leaderboard rows with names and value labels; wide names are cut and clipped', () => {
    const svg = barsSvg(
      parse({
        title: 'Fuel this month <ETS2>',
        unit: 'L',
        kind: 'rows',
        height: 300,
        // Display names are at most 32 characters, but 32 wide letters don't fit the column.
        labels: ['Alice', 'Bob', 'W'.repeat(32)],
        values: [820, 610, 390],
        value_labels: ['820 L', '610 L', '390 L'],
      }),
    );
    expect(svg).toContain('&lt;ETS2&gt;');
    expect(svg).toContain('>820 L<');
    expect(svg).not.toContain(`>${'W'.repeat(32)}<`);
    expect(svg).toContain('…');
    expect(svg).toContain('clip-path="url(#names)"');
    expect(svg).toContain('>Alice<');
    expect(rects(svg, '#1f6feb')).toBe(3);
  });

  it('says "No data" when every value is missing', () => {
    expect(barsSvg(parse({ title: 'x', unit: 'mi', labels: ['a', 'b'], values: [null, null] }))).toContain('No data');
  });

  it('refuses labels and values of different lengths', () => {
    expect(barsRenderRequestSchema.safeParse({ title: 'x', unit: 'mi', labels: ['a'], values: [1, 2] }).success).toBe(false);
    expect(barsRenderRequestSchema.safeParse({ title: 'x', unit: 'mi', kind: 'rows', labels: ['a'], values: [1], value_labels: [] }).success).toBe(false);
  });

  it('keeps axis numbers short and cuts text to fit', () => {
    expect(formatTick(12_500)).toBe('12.5k');
    expect(formatTick(1_500_000)).toBe('1.5M');
    expect(formatTick(250)).toBe('250');
    expect(fitText('short', 12, 500)).toBe('short');
    expect(fitText('x'.repeat(200), 12, 60).endsWith('…')).toBe(true);
  });

  it('renders a PNG of the requested size with blue bars', async () => {
    const img = await decodePng(renderBars(parse({ title: 'Distance per week', unit: 'mi', width: 600, height: 300, labels: ['W1'], values: [100] })));
    expect([img.width, img.height]).toEqual([600, 300]);
    // The single bar is centred in the plot.
    expect(near(img.pixel(64 + (600 - 64 - 24) / 2, 200), hex('#1f6feb'))).toBe(true);
  });
});
