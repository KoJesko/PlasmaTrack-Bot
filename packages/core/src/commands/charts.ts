import type { Series } from '../../api/schemas.ts';
import { CHART_BAND_KINDS, type ChartRenderRequest } from '../../render/protocol.ts';

// Speed and fuel charts from the server's downsampled series (ADMIN_API §5).
// Each bucket carries its min and max; the charts plot the max, so speed
// peaks are never smoothed away.

type Band = (typeof CHART_BAND_KINDS)[number];

function seconds(t0: number, iso: string): number | null {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : Math.max(0, (ms - t0) / 1000);
}

function common(series: Series): Pick<ChartRenderRequest, 'bands' | 'markers'> & { t0: number } {
  const t0 = Date.parse(series.points[0]?.t ?? '');
  const bands = series.windows
    .filter((w): w is typeof w & { kind: Band } => (CHART_BAND_KINDS as readonly string[]).includes(w.kind))
    .map((w) => ({ from: seconds(t0, w.from), to: seconds(t0, w.to), kind: w.kind }))
    .filter((b): b is { from: number; to: number; kind: Band } => b.from !== null && b.to !== null && b.to >= b.from)
    .slice(0, 500);
  const markers = series.markers
    .map((m) => ({ t: seconds(t0, m.at), label: m.litres !== undefined ? `${m.kind} ${m.litres} L` : m.kind }))
    .filter((m): m is { t: number; label: string } => m.t !== null)
    .map((m) => ({ ...m, label: m.label.slice(0, 40) }))
    .slice(0, 50);
  return { t0, bands, markers };
}

export function speedChart(series: Series, title: string): ChartRenderRequest | null {
  if (series.points.length === 0) return null;
  const { t0, bands, markers } = common(series);
  if (Number.isNaN(t0)) return null;
  const points = series.points
    .map((p) => [seconds(t0, p.t), p.speed_mph_max] as const)
    .filter((p): p is readonly [number, number | null] => p[0] !== null)
    .map(([t, v]) => [t, v] as [number, number | null]);
  const thresholds = [
    ...(series.penalty_over_mph !== undefined ? [{ value: series.penalty_over_mph, label: `Penalty ${series.penalty_over_mph} mph` }] : []),
    ...(series.invalid_over_mph !== undefined ? [{ value: series.invalid_over_mph, label: `Invalid ${series.invalid_over_mph} mph` }] : []),
  ];
  return { title: `${title}: speed`.slice(0, 100), unit: 'mph', points, thresholds, bands, markers };
}

export function fuelChart(series: Series, title: string): ChartRenderRequest | null {
  const { t0, bands, markers } = common(series);
  if (Number.isNaN(t0)) return null;
  const points = series.points
    .map((p) => [seconds(t0, p.t), p.fuel_l_max ?? null] as const)
    .filter((p): p is readonly [number, number | null] => p[0] !== null)
    .map(([t, v]) => [t, v] as [number, number | null]);
  if (!points.some(([, v]) => v !== null)) return null;
  return { title: `${title}: fuel`.slice(0, 100), unit: 'L', points, bands, markers };
}
