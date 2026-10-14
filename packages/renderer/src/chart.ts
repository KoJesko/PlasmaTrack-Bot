import type { ParsedChartRenderRequest } from '@plasmatrack/core';
import { escapeXml, FONT_FAMILY, svgToPng, textWidth } from './svg.ts';

// Speed / fuel charts for moderators: one series over job time, with
// thresholds, shaded windows (reverted, pause, ferry, train, refuel, gap) and
// markers (e.g. a fuel jump that triggered review).

const MARGIN = { left: 64, right: 24, top: 52, bottom: 44 };

export const BAND_STYLE: Record<string, { color: string; opacity: number; label: string }> = {
  reverted: { color: '#d62828', opacity: 0.14, label: 'Reverted' },
  pause: { color: '#8a8a8a', opacity: 0.18, label: 'Paused' },
  ferry: { color: '#1f6feb', opacity: 0.14, label: 'Ferry' },
  train: { color: '#6f42c1', opacity: 0.14, label: 'Train' },
  refuel: { color: '#2da44e', opacity: 0.18, label: 'Refuel' },
  gap: { color: '#000000', opacity: 0.08, label: 'Gap' },
};

const THRESHOLD_COLORS = ['#d62828', '#f28c28', '#6f42c1', '#2da44e', '#8a8a8a'];

/**
 * Keeps the minimum and maximum of every pixel column, in time order, so a
 * one-sample spike is never averaged away. `null` values split the line.
 */
export function downsample(points: readonly (readonly [number, number | null])[], columns: number, tMax: number): (readonly [number, number | null])[] {
  if (points.length <= columns * 2) return points.slice();
  const out: (readonly [number, number | null])[] = [];
  let bucket = -1;
  let lo: readonly [number, number] | null = null;
  let hi: readonly [number, number] | null = null;
  const flush = () => {
    if (lo && hi) {
      if (lo === hi) out.push(lo);
      else out.push(...(lo[0] <= hi[0] ? [lo, hi] : [hi, lo]));
    }
    lo = hi = null;
  };
  for (const p of points) {
    const b = Math.min(columns - 1, Math.floor((p[0] / Math.max(tMax, 1e-9)) * columns));
    if (b !== bucket) {
      flush();
      bucket = b;
    }
    if (p[1] === null) {
      flush();
      out.push(p);
      continue;
    }
    const v = p as readonly [number, number];
    if (!lo || v[1] < lo[1]) lo = v;
    if (!hi || v[1] > hi[1]) hi = v;
  }
  flush();
  return out;
}

export function niceTicks(min: number, max: number, count: number): number[] {
  const span = Math.max(max - min, 1e-9);
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const ticks: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) ticks.push(Number(v.toFixed(10)));
  return ticks;
}

const TIME_STEPS = [10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200];

/** Ticks at round clock intervals (1 min, 5 min, 15 min, 1 h, …) rather than decimal steps. */
export function timeTicks(max: number, count: number): number[] {
  const step = TIME_STEPS.find((s) => max / s <= count) ?? Math.ceil(max / count / 3600) * 3600;
  const ticks: number[] = [];
  for (let t = 0; t <= max + 1e-9; t += step) ticks.push(t);
  return ticks;
}

export function formatDuration(seconds: number): string {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

export function chartSvg(req: ParsedChartRenderRequest): string {
  const { width, height } = req;
  const plotW = width - MARGIN.left - MARGIN.right;
  const plotH = height - MARGIN.top - MARGIN.bottom;

  const tMax = Math.max(...req.points.map((p) => p[0]), ...req.bands.map((b) => b.to), ...req.markers.map((m) => m.t), 1);
  const values = req.points.flatMap((p) => (p[1] === null ? [] : [p[1]]));
  const vMin = Math.min(0, ...values, ...req.thresholds.map((t) => t.value));
  const vMaxRaw = Math.max(...values, ...req.thresholds.map((t) => t.value), vMin + 1);
  const yTicks = niceTicks(vMin, vMaxRaw * 1.05, 5);
  const vMax = Math.max(vMaxRaw * 1.05, yTicks[yTicks.length - 1] ?? vMaxRaw);

  const x = (t: number) => MARGIN.left + (t / tMax) * plotW;
  const y = (v: number) => MARGIN.top + plotH - ((v - vMin) / (vMax - vMin)) * plotH;
  const f = (n: number) => n.toFixed(1);

  const parts: string[] = [];
  parts.push(`<rect width="${width}" height="${height}" fill="#ffffff"/>`);
  parts.push(`<text x="${MARGIN.left}" y="28" font-size="16" font-weight="bold" fill="#1d1d1d">${escapeXml(req.title)}</text>`);

  // Bands, then a legend for the kinds that appear.
  for (const b of req.bands) {
    const s = BAND_STYLE[b.kind]!;
    const x0 = x(Math.min(b.from, b.to));
    parts.push(`<rect x="${f(x0)}" y="${MARGIN.top}" width="${f(Math.max(1, x(Math.max(b.from, b.to)) - x0))}" height="${plotH}" fill="${s.color}" fill-opacity="${s.opacity}"/>`);
  }
  let lx = width - MARGIN.right;
  for (const kind of [...new Set(req.bands.map((b) => b.kind))].reverse()) {
    const s = BAND_STYLE[kind]!;
    lx -= textWidth(s.label, 12) + 26;
    parts.push(`<rect x="${lx}" y="18" width="12" height="12" fill="${s.color}" fill-opacity="${Math.min(1, s.opacity * 3)}"/>`);
    parts.push(`<text x="${lx + 16}" y="28.5" font-size="12" fill="#333333">${escapeXml(s.label)}</text>`);
  }

  // Grid and axes.
  for (const v of yTicks) {
    parts.push(`<line x1="${MARGIN.left}" x2="${MARGIN.left + plotW}" y1="${f(y(v))}" y2="${f(y(v))}" stroke="#e6e6e6"/>`);
    parts.push(`<text x="${MARGIN.left - 8}" y="${f(y(v) + 4)}" font-size="11" fill="#555555" text-anchor="end">${v}</text>`);
  }
  for (const t of timeTicks(tMax, 8)) {
    parts.push(`<line x1="${f(x(t))}" x2="${f(x(t))}" y1="${MARGIN.top + plotH}" y2="${MARGIN.top + plotH + 4}" stroke="#555555"/>`);
    parts.push(`<text x="${f(x(t))}" y="${MARGIN.top + plotH + 18}" font-size="11" fill="#555555" text-anchor="middle">${formatDuration(t)}</text>`);
  }
  parts.push(`<line x1="${MARGIN.left}" x2="${MARGIN.left + plotW}" y1="${MARGIN.top + plotH}" y2="${MARGIN.top + plotH}" stroke="#555555"/>`);
  parts.push(`<text x="16" y="${f(MARGIN.top + plotH / 2)}" font-size="12" fill="#555555" text-anchor="middle" transform="rotate(-90 16 ${f(MARGIN.top + plotH / 2)})">${escapeXml(req.unit)}</text>`);

  // Series.
  let d = '';
  let pen = false;
  for (const [t, v] of downsample(req.points, Math.max(1, Math.floor(plotW)), tMax)) {
    if (v === null) {
      pen = false;
      continue;
    }
    d += `${pen ? 'L' : 'M'}${f(x(t))} ${f(y(v))}`;
    pen = true;
  }
  parts.push(`<path d="${d}" fill="none" stroke="#1f6feb" stroke-width="1.6" stroke-linejoin="round"/>`);

  // Thresholds and markers on top.
  req.thresholds.forEach((th, i) => {
    const color = THRESHOLD_COLORS[i % THRESHOLD_COLORS.length];
    parts.push(`<line x1="${MARGIN.left}" x2="${MARGIN.left + plotW}" y1="${f(y(th.value))}" y2="${f(y(th.value))}" stroke="${color}" stroke-width="1.5" stroke-dasharray="6 4"/>`);
    // Labels sit at the left end of the line; marker labels sit at the bottom, so they never collide.
    parts.push(`<text x="${MARGIN.left + 6}" y="${f(y(th.value) - 5)}" font-size="11" fill="${color}">${escapeXml(th.label)}</text>`);
  });
  for (const m of req.markers) {
    parts.push(`<line x1="${f(x(m.t))}" x2="${f(x(m.t))}" y1="${MARGIN.top}" y2="${MARGIN.top + plotH}" stroke="#d62828" stroke-width="1.2" stroke-dasharray="2 3"/>`);
    parts.push(`<text x="${f(x(m.t) + 4)}" y="${MARGIN.top + plotH - 6}" font-size="11" fill="#d62828">${escapeXml(m.label)}</text>`);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" font-family="${FONT_FAMILY}">${parts.join('')}</svg>`;
}

export function renderChart(req: ParsedChartRenderRequest): Uint8Array {
  return svgToPng(chartSvg(req));
}
