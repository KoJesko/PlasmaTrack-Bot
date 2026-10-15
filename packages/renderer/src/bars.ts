import type { ParsedBarsRenderRequest } from '@plasmatrack/core';
import { niceTicks } from './chart.ts';
import { escapeXml, FONT_FAMILY, svgToPng } from './svg.ts';

// Labelled charts (owner, 2026-10-15): a player's totals per day, week or
// month (columns), their running total (line), and leaderboard comparisons
// (rows). Negative values (income can be a loss) hang below the zero line.

const BLUE = '#1f6feb';
const RED = '#d62828';

/** Axis numbers stay short: 12k, 1.5M. */
export function formatTick(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e6) return `${Number((v / 1e6).toFixed(2))}M`;
  if (a >= 1e4) return `${Number((v / 1e3).toFixed(1))}k`;
  return String(Number(v.toFixed(2)));
}

const NARROW = new Set('iljtfrI.,:;\'|!()[] ');
const WIDE = new Set('MWmw@%');

/**
 * Text width with per-character estimates (Noto Sans). Player names are arbitrary,
 * and an average width badly undercounts names like "WWWW…".
 */
export function measure(text: string, fontSize: number): number {
  let em = 0;
  for (const c of text) em += WIDE.has(c) ? 0.92 : NARROW.has(c) ? 0.3 : c >= 'A' && c <= 'Z' ? 0.68 : 0.57;
  return Math.ceil(em * fontSize);
}

/** Cuts a label to fit `max` pixels, with an ellipsis. */
export function fitText(text: string, fontSize: number, max: number): string {
  if (measure(text, fontSize) <= max) return text;
  let s = text;
  while (s.length > 1 && measure(`${s}…`, fontSize) > max) s = s.slice(0, -1);
  return `${s}…`;
}

function valueRange(values: readonly (number | null)[]) {
  const present = values.filter((v): v is number => v !== null);
  const lo = Math.min(0, ...present);
  const hi = Math.max(0, ...present);
  const span = hi - lo || 1;
  const ticks = niceTicks(lo < 0 ? lo - span * 0.05 : 0, hi + span * 0.05, 5);
  return { min: Math.min(lo, ticks[0] ?? lo), max: Math.max(hi, ticks[ticks.length - 1] ?? hi, lo + 1), ticks, empty: present.length === 0 };
}

export function barsSvg(req: ParsedBarsRenderRequest): string {
  const { width, height } = req;
  const parts: string[] = [`<rect width="${width}" height="${height}" fill="#ffffff"/>`];
  parts.push(`<text x="24" y="28" font-size="16" font-weight="bold" fill="#1d1d1d">${escapeXml(req.title)}</text>`);
  const f = (n: number) => n.toFixed(1);
  const range = valueRange(req.values);

  if (req.kind === 'rows') {
    const labelW = Math.min(240, Math.max(...req.labels.map((l) => measure(l, 12))) + 8);
    const valueLabels = req.value_labels ?? req.values.map((v) => (v === null ? '—' : formatTick(v)));
    const valueW = Math.max(...valueLabels.map((l) => measure(l, 12))) + 12;
    // Names never spill past the left edge, even if the estimate is off.
    parts.push(`<clipPath id="names"><rect x="24" y="0" width="${labelW - 8}" height="${height}"/></clipPath>`);
    const left = 24 + labelW;
    const right = width - 24 - valueW;
    const top = 52;
    const rowH = (height - top - 16) / req.values.length;
    const x = (v: number) => left + ((v - range.min) / (range.max - range.min)) * (right - left);
    req.values.forEach((v, i) => {
      const cy = top + rowH * i + rowH / 2;
      parts.push(
        `<text x="${left - 8}" y="${f(cy + 4)}" font-size="12" fill="#1d1d1d" text-anchor="end" clip-path="url(#names)">${escapeXml(fitText(req.labels[i]!, 12, labelW - 8))}</text>`,
      );
      if (v !== null) {
        const x0 = Math.min(x(0), x(v));
        const w = Math.max(1, Math.abs(x(v) - x(0)));
        parts.push(`<rect x="${f(x0)}" y="${f(cy - rowH * 0.35)}" width="${f(w)}" height="${f(rowH * 0.7)}" rx="2" fill="${v < 0 ? RED : BLUE}"/>`);
      }
      parts.push(`<text x="${f((v === null ? x(0) : Math.max(x(0), x(v))) + 6)}" y="${f(cy + 4)}" font-size="12" fill="#333333">${escapeXml(valueLabels[i]!)}</text>`);
    });
    if (range.min < 0) parts.push(`<line x1="${f(x(0))}" x2="${f(x(0))}" y1="${top}" y2="${height - 16}" stroke="#555555"/>`);
    // Value labels normally carry the unit; without them, show it once.
    if (!req.value_labels) parts.push(`<text x="${width - 24}" y="28" font-size="12" fill="#555555" text-anchor="end">${escapeXml(req.unit)}</text>`);
    return wrap(width, height, parts);
  }

  const margin = { left: 64, right: 24, top: 52, bottom: 56 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const n = req.values.length;
  const slot = plotW / n;
  const cx = (i: number) => margin.left + slot * i + slot / 2;
  const y = (v: number) => margin.top + plotH - ((v - range.min) / (range.max - range.min)) * plotH;

  for (const v of range.ticks) {
    parts.push(`<line x1="${margin.left}" x2="${margin.left + plotW}" y1="${f(y(v))}" y2="${f(y(v))}" stroke="#e6e6e6"/>`);
    parts.push(`<text x="${margin.left - 8}" y="${f(y(v) + 4)}" font-size="11" fill="#555555" text-anchor="end">${formatTick(v)}</text>`);
  }
  parts.push(`<text x="16" y="${f(margin.top + plotH / 2)}" font-size="12" fill="#555555" text-anchor="middle" transform="rotate(-90 16 ${f(margin.top + plotH / 2)})">${escapeXml(req.unit)}</text>`);

  if (req.kind === 'columns') {
    req.values.forEach((v, i) => {
      if (v === null) return;
      const y0 = Math.min(y(0), y(v));
      const w = Math.max(1, slot * 0.7);
      parts.push(`<rect x="${f(cx(i) - w / 2)}" y="${f(y0)}" width="${f(w)}" height="${f(Math.max(v === 0 ? 0 : 1, Math.abs(y(v) - y(0))))}" fill="${v < 0 ? RED : BLUE}"/>`);
    });
  } else {
    let d = '';
    let pen = false;
    const dots: string[] = [];
    req.values.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${f(cx(i))} ${f(y(v))}`;
      pen = true;
      if (n <= 60) dots.push(`<circle cx="${f(cx(i))}" cy="${f(y(v))}" r="3" fill="${BLUE}"/>`);
    });
    parts.push(`<path d="${d}" fill="none" stroke="${BLUE}" stroke-width="2" stroke-linejoin="round"/>`, ...dots);
  }

  // Zero line, then as many x labels as fit without overlapping.
  parts.push(`<line x1="${margin.left}" x2="${margin.left + plotW}" y1="${f(y(0))}" y2="${f(y(0))}" stroke="#555555"/>`);
  const widest = Math.max(...req.labels.map((l) => measure(l, 11))) + 10;
  const every = Math.max(1, Math.ceil(widest / slot));
  req.labels.forEach((label, i) => {
    if (i % every !== 0) return;
    parts.push(`<text x="${f(cx(i))}" y="${margin.top + plotH + 18}" font-size="11" fill="#555555" text-anchor="middle">${escapeXml(label)}</text>`);
  });
  if (range.empty) {
    parts.push(`<text x="${f(margin.left + plotW / 2)}" y="${f(margin.top + plotH / 2)}" font-size="14" fill="#8a8a8a" text-anchor="middle">No data</text>`);
  }
  return wrap(width, height, parts);
}

function wrap(width: number, height: number, parts: string[]): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" font-family="${FONT_FAMILY}">${parts.join('')}</svg>`;
}

export function renderBars(req: ParsedBarsRenderRequest): Uint8Array {
  return svgToPng(barsSvg(req));
}
