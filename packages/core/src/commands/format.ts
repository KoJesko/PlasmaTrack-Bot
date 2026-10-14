import type { Game, Outcome } from '../api/schemas.ts';

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

/** Points as the server gave them; a job in review shows what it holds. */
export function pointsText(outcome: Outcome, points: number | null, held: number | null | undefined): string {
  if (outcome === 'pending_review') return held === null || held === undefined ? 'held for review' : `${held} (held for review)`;
  return points === null ? '—' : String(points);
}

/** Discord renders `<t:…>` in each reader's own time zone. */
export function discordTime(iso: string | null | undefined, style: 'f' | 'd' | 'D' | 'R' | 'F' = 'f'): string {
  const ms = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(ms) ? '—' : `<t:${Math.floor(ms / 1000)}:${style}>`;
}

/** Plain text for embeds: no mentions, no markdown injection from names. */
export function escapeMarkdown(text: string): string {
  return text.replace(/([\\*_`~|>#\-[\]()])/g, '\\$1').replace(/@/g, '@\u200b');
}
