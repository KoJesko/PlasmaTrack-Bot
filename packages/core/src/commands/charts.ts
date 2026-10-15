import type { Series } from '../api/schemas.ts';
import type { TaskDeps } from '../interactions/types.ts';
import { CHART_BAND_KINDS, type ChartRenderRequest } from '../render/protocol.ts';

// Charts over one job's time from the server's downsampled series: the admin
// series (ADMIN_API §5, any job, in /review) or the public one (valid and
// approved jobs, reverted parts hidden; /graph job). Each bucket carries its
// min and max; the charts plot the max, so speed peaks are never smoothed away.

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

/** One value per bucket, against seconds since the job's start. */
function line(series: Series, title: string, unit: string, pick: (p: Series['points'][number]) => number | null | undefined): ChartRenderRequest | null {
  if (series.points.length === 0) return null;
  const { t0, bands, markers } = common(series);
  if (Number.isNaN(t0)) return null;
  const points = series.points
    .map((p) => [seconds(t0, p.t), pick(p) ?? null] as const)
    .filter((p): p is readonly [number, number | null] => p[0] !== null)
    .map(([t, v]) => [t, v] as [number, number | null]);
  if (!points.some(([, v]) => v !== null)) return null;
  return { title: title.slice(0, 100), unit, points, bands, markers };
}

/** Distance driven so far: the odometer (`game`) or the scored part at 1:1 (`world`). */
export function distanceChart(series: Series, title: string, scale: 'game' | 'world'): ChartRenderRequest | null {
  return scale === 'game'
    ? line(series, `${title}: distance in game`, 'mi', (p) => p.game_mi)
    : line(series, `${title}: distance at 1:1 (scored)`, 'mi', (p) => p.world_mi);
}

/** Cargo damage; missing for jobs processed before the server recorded it. */
export function damageChart(series: Series, title: string): ChartRenderRequest | null {
  return line(series, `${title}: cargo damage`, '%', (p) => p.damage_pct_max);
}

export const JOB_CHARTS = ['speed', 'fuel', 'distance', 'damage'] as const;
export type JobChart = (typeof JOB_CHARTS)[number];

export interface RenderedChart {
  /** File name, e.g. "speed.png". */
  name: string;
  title: string;
  bytes: Uint8Array<ArrayBuffer>;
}

/**
 * Renders the chosen job charts; a chart without data, or one the renderer
 * can't draw right now, is left out (logged).
 */
export async function jobCharts(series: Series, title: string, deps: Pick<TaskDeps, 'renderer' | 'logger'>, which: readonly JobChart[] = JOB_CHARTS): Promise<RenderedChart[]> {
  const wanted: { name: string; title: string; req: ChartRenderRequest | null }[] = [];
  if (which.includes('speed')) wanted.push({ name: 'speed', title: 'Speed (highest in each slice)', req: speedChart(series, title) });
  if (which.includes('fuel')) wanted.push({ name: 'fuel', title: 'Fuel in the tank', req: fuelChart(series, title) });
  if (which.includes('distance')) {
    wanted.push({ name: 'distance-game', title: 'Distance in game', req: distanceChart(series, title, 'game') });
    wanted.push({ name: 'distance-world', title: 'Distance at 1:1 (scored)', req: distanceChart(series, title, 'world') });
  }
  if (which.includes('damage')) wanted.push({ name: 'damage', title: 'Cargo damage', req: damageChart(series, title) });
  const out = await Promise.all(
    wanted.map(async (w) => {
      if (!w.req) return null;
      try {
        return { name: `${w.name}.png`, title: w.title, bytes: (await deps.renderer.renderChart(w.req)).bytes };
      } catch (err) {
        deps.logger.warn('chart unavailable', { err, chart: w.name });
        return null;
      }
    }),
  );
  return out.filter((c): c is RenderedChart => c !== null);
}
