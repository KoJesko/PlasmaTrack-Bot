import type {
  APIApplicationCommandAttachmentOption,
  APIApplicationCommandIntegerOption,
  APIApplicationCommandNumberOption,
  APIApplicationCommandStringOption,
  APIChatInputApplicationCommandInteraction,
} from 'discord-api-types/v10';
import type { DistanceUnit, FuelUnit, JobEdit } from '../api/client.ts';
import { ApplicationCommandOptionType } from '../discord/constants.ts';
import { distance } from './format.ts';
import { numberOption, stringOption } from './options.ts';

// Fields of a manual submission (PUBLIC_API §6) and of a moderator's edit
// (ADMIN_API §14): option definitions, parsing and display. The server does
// all scoring; the bot only converts units for showing what a player typed.

export const KM_PER_MI = 1.609344;
const L_PER_GAL: Record<FuelUnit, number> = { l: 1, us_gal: 3.785411784, uk_gal: 4.54609 };
const FUEL_LABEL: Record<FuelUnit, string> = { l: 'L', us_gal: 'US gal', uk_gal: 'UK gal' };

/** Images the server accepts (it checks the bytes; so do we). */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/avif'] as const;
/** Largest attachment the bot downloads for compression. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** The server's limit per image, after compression. */
export const MAX_EVIDENCE_BYTES = 5 * 1024 * 1024;

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Sections at another map scale per job (owner, 2026-10-15; PUBLIC_API §6). */
export const MAX_ADJUSTED_SECTIONS = 5;
/** City streets are scale 3 in both games. */
export const CITY_SCALE = 3;
/** A city-scale section counts only from 1 mi of real distance: 3 mi in game. */
const CITY_MIN_GAME: Record<DistanceUnit, number> = { mi: 3, km: 3 * KM_PER_MI };
export const CITY_RULE = 'A city-scale (1:3) section counts only from 3 mi (4.83 km) in game, which is 1 mi of real distance.';

/** The owner's rule, which the server enforces too: shorter city sections are refused. */
export function citySectionTooShort(distance: number, scale: number, unit: DistanceUnit): boolean {
  return scale === CITY_SCALE && distance < CITY_MIN_GAME[unit];
}

// ---------------------------------------------------------------------------
// Option builders

export function textOption(name: string, description: string, required: boolean, maxLength = 100): APIApplicationCommandStringOption {
  return { type: ApplicationCommandOptionType.String, name, description, required, min_length: 1, max_length: maxLength };
}

/** Which adjusted-scale section, numbered from 1 as /review shows them. */
export function sectionOption(description = 'Adjusted-scale section number, as /review shows it (1–5)'): APIApplicationCommandIntegerOption {
  return { type: ApplicationCommandOptionType.Integer, name: 'section', description, required: false, min_value: 1, max_value: MAX_ADJUSTED_SECTIONS };
}

export function numOption(name: string, description: string, required: boolean, min?: number, max?: number): APIApplicationCommandNumberOption {
  return {
    type: ApplicationCommandOptionType.Number,
    name,
    description,
    required,
    ...(min !== undefined ? { min_value: min } : {}),
    ...(max !== undefined ? { max_value: max } : {}),
  };
}

export function imageOption(name: string, description: string, required: boolean): APIApplicationCommandAttachmentOption {
  return { type: ApplicationCommandOptionType.Attachment, name, description, required };
}

export function unitOption(required: boolean): APIApplicationCommandStringOption {
  return {
    type: ApplicationCommandOptionType.String,
    name: 'unit',
    description: required ? 'Unit of every distance you enter' : 'Unit of the distances you enter (needed with any distance)',
    required,
    choices: [
      { name: 'Miles (mi)', value: 'mi' },
      { name: 'Kilometres (km)', value: 'km' },
    ],
  };
}

export function fuelUnitOption(required: boolean): APIApplicationCommandStringOption {
  return {
    type: ApplicationCommandOptionType.String,
    name: 'fuel_unit',
    description: required ? 'Unit of fuel_used' : 'Unit of fuel_used (needed with it)',
    required,
    choices: [
      { name: 'Litres', value: 'l' },
      { name: 'US gallons', value: 'us_gal' },
      { name: 'UK gallons', value: 'uk_gal' },
    ],
  };
}

export const DATE_EXAMPLE = '2026-10-14T07:00:00Z';

// ---------------------------------------------------------------------------
// Parsing

export function isDistanceUnit(v: unknown): v is DistanceUnit {
  return v === 'mi' || v === 'km';
}

export function isFuelUnit(v: unknown): v is FuelUnit {
  return v === 'l' || v === 'us_gal' || v === 'uk_gal';
}

/**
 * A UTC time in ISO 8601 ("2026-10-14T07:00:00Z", seconds optional, a space
 * instead of T and a missing Z are accepted) → RFC 3339, or null. Other
 * offsets are refused: the rule is UTC.
 */
export function parseUtcInstant(input: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|\+00:00|\+00)?$/i.exec(input.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s = '0', ms = '0'] = m;
  const t = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), Number(ms.padEnd(3, '0')));
  const date = new Date(t);
  if (Number.isNaN(t) || date.getUTCMonth() !== Number(mo) - 1 || date.getUTCDate() !== Number(d) || Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) {
    return null;
  }
  return date.toISOString();
}

/** "Mod A, Mod B" → ["Mod A", "Mod B"] (at most 100 names of 100 characters). */
export function splitMods(input: string): string[] {
  return input
    .split(',')
    .map((s) => s.trim().slice(0, 100))
    .filter(Boolean)
    .slice(0, 100);
}

// ---------------------------------------------------------------------------
// Display

/** What the player typed, miles first with km in brackets. */
export function typedDistance(value: number, unit: DistanceUnit): string {
  const km = unit === 'km' ? value : value * KM_PER_MI;
  const mi = unit === 'mi' ? value : value / KM_PER_MI;
  return distance(round2(mi), round2(km));
}

export function typedFuel(value: number, unit: FuelUnit): string {
  return unit === 'l' ? `${round2(value)} L` : `${round2(value)} ${FUEL_LABEL[unit]} (${round2(value * L_PER_GAL[unit])} L)`;
}

export function money(value: number, game: 'ets2' | 'ats'): string {
  const sign = value < 0 ? '−' : '';
  const n = Math.abs(value).toLocaleString('en-US', { maximumFractionDigits: 2 });
  return game === 'ets2' ? `${sign}€${n}` : `${sign}$${n}`;
}

// ---------------------------------------------------------------------------
// Moderator corrections (/approve-manual, /edit-job stats)

/** The stat options moderators may correct (all optional). */
export const STAT_OPTIONS = [
  unitOption(false),
  fuelUnitOption(false),
  numOption('distance', 'Distance the game logged', false, 0.01, 100_000),
  numOption('map_scale', 'Map scale', false, 0.01, 1000),
  numOption('uk_distance', 'ETS2: distance driven in the UK', false, 0.01, 100_000),
  sectionOption('Adjusted-scale section to correct, as /review numbers it (1–5)'),
  numOption('adjusted_distance', 'Distance of that adjusted-scale section', false, 0.01, 100_000),
  numOption('adjusted_scale', 'Scale of that adjusted-scale section', false, 0.01, 1000),
  numOption('fuel_used', 'Fuel used', false, 0, 100_000),
  numOption('damage', 'Cargo damage, percent (0–100)', false, 0, 100),
  numOption('profit', 'Profit, in the game’s currency', false, -1_000_000_000, 1_000_000_000),
  textOption('date_started', `Start, UTC, like ${DATE_EXAMPLE}`, false, 40),
  textOption('date_ended', `End, UTC, like ${DATE_EXAMPLE}`, false, 40),
];

/** Reads the stat corrections; problems are in plain words for the moderator. */
export function readStatChanges(i: APIChatInputApplicationCommandInteraction): { changes: JobEdit; problems: string[] } {
  const changes: JobEdit = {};
  const problems: string[] = [];
  const unit = stringOption(i, 'unit');
  const fuelUnit = stringOption(i, 'fuel_unit');
  const d = numberOption(i, 'distance');
  const ukD = numberOption(i, 'uk_distance');
  const adjD = numberOption(i, 'adjusted_distance');
  const adjS = numberOption(i, 'adjusted_scale');
  const fuel = numberOption(i, 'fuel_used');

  if (d !== undefined) changes.distance = d;
  if (ukD !== undefined) changes.uk = { distance: ukD };
  const section = numberOption(i, 'section');
  if (adjD !== undefined || adjS !== undefined) {
    if (section === undefined) problems.push('Give `section` (the number /review shows) with `adjusted_distance` or `adjusted_scale`.');
    else changes.adjusted_scales = { [String(section - 1)]: { ...(adjD !== undefined ? { distance: adjD } : {}), ...(adjS !== undefined ? { scale: adjS } : {}) } };
  } else if (section !== undefined) problems.push('`section` goes with `adjusted_distance` or `adjusted_scale`.');
  if (d !== undefined || ukD !== undefined || adjD !== undefined) {
    if (isDistanceUnit(unit)) changes.unit = unit;
    else problems.push('Give `unit` with any distance.');
  }
  // When both are given here, the city rule can be checked now (the server checks always).
  if (adjD !== undefined && adjS !== undefined && isDistanceUnit(unit) && citySectionTooShort(adjD, adjS, unit)) problems.push(CITY_RULE);
  if (fuel !== undefined) {
    changes.fuel_used = fuel;
    if (isFuelUnit(fuelUnit)) changes.fuel_unit = fuelUnit;
    else problems.push('Give `fuel_unit` with `fuel_used`.');
  }
  const scale = numberOption(i, 'map_scale');
  if (scale !== undefined) changes.map_scale = scale;
  const damage = numberOption(i, 'damage');
  if (damage !== undefined) changes.damage = damage;
  const profit = numberOption(i, 'profit');
  if (profit !== undefined) changes.profit = profit;
  for (const [option, field] of [
    ['date_started', 'started_at'],
    ['date_ended', 'ended_at'],
  ] as const) {
    const raw = stringOption(i, option);
    if (raw === undefined) continue;
    const iso = parseUtcInstant(raw);
    if (iso) changes[field] = iso;
    else problems.push(`\`${option}\` must be a UTC time like \`${DATE_EXAMPLE}\`.`);
  }
  if (changes.started_at && changes.ended_at && Date.parse(changes.ended_at) <= Date.parse(changes.started_at)) {
    problems.push('`date_ended` must be after `date_started`.');
  }
  return { changes, problems };
}

function sectionParts(v: Record<string, unknown>, dist: (n: number) => string): string {
  return Object.entries(v)
    .map(([k, x]) => `${k.replace(/_/g, ' ')} ${k === 'distance' ? dist(x as number) : k === 'scale' ? `1:${String(x)}` : String(x)}`)
    .join(', ');
}

/** One line per corrected field, for the moderator's confirmation. */
export function describeChanges(changes: JobEdit): string[] {
  const unit = changes.unit;
  const dist = (v: number) => (unit ? typedDistance(v, unit) : String(v));
  const lines: string[] = [];
  const name = (k: string) => k.replace(/_/g, ' ');
  for (const [k, v] of Object.entries(changes)) {
    if (k === 'unit' || k === 'fuel_unit') continue;
    if (v === null) lines.push(`${name(k)}: cleared`);
    else if (k === 'distance') lines.push(`distance: ${dist(v as number)}`);
    else if (k === 'fuel_used') lines.push(`fuel used: ${changes.fuel_unit ? typedFuel(v as number, changes.fuel_unit) : v}`);
    else if (k === 'uk') lines.push(`UK: ${sectionParts(v as Record<string, unknown>, dist)}`);
    else if (k === 'adjusted_scales') {
      for (const [n, section] of Object.entries(v as Record<string, Record<string, unknown> | null>)) {
        lines.push(`adjusted-scale section ${Number(n) + 1}: ${section === null ? 'removed' : sectionParts(section, dist)}`);
      }
    } else if (Array.isArray(v)) lines.push(`${name(k)}: ${v.join(', ')}`);
    else lines.push(`${name(k)}: ${String(v)}`);
  }
  return lines;
}
