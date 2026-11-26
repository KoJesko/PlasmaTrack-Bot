import type { Game, JobSummary, Outcome } from '../api/schemas.ts';

// Player-facing text. Distances and points are shown exactly as the server
// sends them (server API_CONVENTIONS §6): the bot never converts or rounds.
// Miles first, km in brackets (owner's decision, 2026-10-14).

export const GAME_NAMES: Record<Game, string> = {
  ets2: 'Euro Truck Simulator 2',
  ats: 'American Truck Simulator',
};

export const GAME_SHORT: Record<Game, string> = { ets2: 'ETS2', ats: 'ATS' };

export function isGame(v: unknown): v is Game {
  return v === 'ets2' || v === 'ats';
}

/** "7.07 mi (11.38 km)"; km alone when the server gave no miles. */
export function distance(mi: number | undefined | null, km: number | undefined | null): string {
  if (mi === undefined || mi === null) return km === undefined || km === null ? '—' : `${km} km`;
  return km === undefined || km === null ? `${mi} mi` : `${mi} mi (${km} km)`;
}

export const OUTCOME_LABELS: Record<Outcome, string> = {
  valid: 'Valid',
  approved: 'Approved',
  pending_review: 'In review',
  invalid: 'Invalid',
  rejected: 'Rejected',
  discarded: 'Discarded',
  voided: 'Voided',
  other: 'Unknown',
};

const MULTIPLAYER_LABELS: Record<string, string> = {
  singleplayer: 'Singleplayer',
  truckersmp: 'TruckersMP',
  convoy: 'Convoy',
  haulmp: 'HaulMP',
  trucklinemp: 'TrucklineMP',
};

/** How the job was played. The server's `name` wins, so a new multiplayer mod shows without a bot change. Null when unknown. */
export function multiplayerLabel(mp: JobSummary['multiplayer']): string | null {
  if (!mp) return null;
  const name = mp.name?.trim();
  if (name) return escapeMarkdown(name.slice(0, 64));
  return MULTIPLAYER_LABELS[mp.kind] ?? null;
}

// Coach jobs (ETS2 Coaches DLC, server 433e39f): `job_type` `bus`, first stop
// to last stop, and the passengers' satisfaction instead of cargo damage.

type JobRoute = Pick<JobSummary, 'job_type' | 'market' | 'source' | 'destination'>;
type Place = JobSummary['source'];

/** "Coach line" or "Tourist trip" for a coach job; null for any other job. */
export function coachLabel(job: Pick<JobSummary, 'job_type' | 'market'>): string | null {
  if (job.job_type !== 'bus') return null;
  if (job.market === 'tourist_job') return 'Tourist trip';
  if (job.market === 'company_job') return 'Coach line';
  return 'Coach trip';
}

/** A coach trip that ends at the stop it started from (most tourist trips). */
export function isRoundTrip(job: JobRoute): boolean {
  if (job.job_type !== 'bus') return false;
  const { source: a, destination: b } = job;
  return a.city_id && b.city_id ? a.city_id === b.city_id : a.city_name === b.city_name;
}

const cityName = (p: Place) => escapeMarkdown(p.city_name);

/** "Dover → Calais"; a coach round trip reads "round trip from Umeå". `place` formats one end. */
export function routeText(job: JobRoute, place: (p: Place) => string = cityName): string {
  return isRoundTrip(job) ? `round trip from ${place(job.source)}` : `${place(job.source)} → ${place(job.destination)}`;
}

/** The embed headline: the cargo, or for a coach job what kind of trip it was. */
export function jobHeadline(job: JobRoute & Pick<JobSummary, 'cargo'>, place?: (p: Place) => string): string {
  return `**${coachLabel(job) ?? escapeMarkdown(job.cargo.name)}**: ${routeText(job, place)}`;
}

/** A list line's route: a coach job says what kind of trip it was ("Coach line: Reykjavík → Höfn"). */
export function listRouteText(job: JobRoute): string {
  const coach = coachLabel(job);
  return coach ? `${coach}: ${routeText(job)}` : routeText(job);
}

/** 0–1 → "87.5%". Null when the server gave none (every non-coach job). */
export function satisfactionText(s: number | null | undefined): string | null {
  return typeof s === 'number' && Number.isFinite(s) ? `${Math.round(s * 1000) / 10}%` : null;
}

/** Points as the server gave them; a job in review shows what it holds. */
export function pointsText(outcome: Outcome, points: number | null, held: number | null | undefined): string {
  if (outcome === 'pending_review') return held === null || held === undefined ? 'held for review' : `${held} (held for review)`;
  return points === null ? '—' : String(points);
}

/** Discord renders `<t:…>` in each reader's own time zone. */
export function discordTime(iso: string | null | undefined, style: 'f' | 'd' | 'D' | 'R' | 'F' | 'T' = 'f'): string {
  const ms = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(ms) ? '—' : `<t:${Math.floor(ms / 1000)}:${style}>`;
}

/** Plain text for embeds: no mentions, no markdown injection from names. */
export function escapeMarkdown(text: string): string {
  return text.replace(/([\\*_`~|>#\-[\]()])/g, '\\$1').replace(/@/g, '@\u200b');
}
