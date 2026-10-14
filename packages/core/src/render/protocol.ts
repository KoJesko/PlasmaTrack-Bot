import { z } from 'zod';
import { bytesToHex, hexToBytes, sha256Hex, timingSafeEqual, utf8 } from '../bytes.ts';

// The bot ↔ renderer contract. This is internal to this repo (the renderer is
// ours), unlike the PlasmaTrack server API, which we only consume.

/** Bump when the request format or the rendered style changes; it is part of every cache key. */
export const RENDER_PROTOCOL_VERSION = 2;

export const ROUTE_PATH = '/v1/render/route';
export const CHART_PATH = '/v1/render/chart';

// ---------------------------------------------------------------------------
// Route images

/**
 * Per-stretch scale class, as sent by the server (PLAN §8). The renderer never
 * derives a class from a scale value; anything it doesn't recognise is drawn
 * as `unknown`.
 */
export const SCALE_CLASSES = ['city', 'road', 'one_to_one', 'nonstandard', 'unknown'] as const;
export type ScaleClass = (typeof SCALE_CLASSES)[number];

export const SCALE_CLASS_LABELS: Record<ScaleClass, string> = {
  city: 'City scale',
  road: 'Road scale (vanilla)',
  one_to_one: '1:1',
  nonstandard: 'Non-standard scale',
  unknown: 'Scale not reported',
};

export function normalizeScaleClass(value: unknown): ScaleClass {
  return (SCALE_CLASSES as readonly unknown[]).includes(value) ? (value as ScaleClass) : 'unknown';
}

/**
 * What a stretch is (server contract PUBLIC_API §4). Only `driving` follows
 * the road; the others are straight lines between their ends. Anything the
 * renderer doesn't recognise is drawn as `gap` (missing data).
 */
export const ROUTE_SEGMENTS = ['driving', 'ferry', 'train', 'teleport', 'gap'] as const;
export type RouteSegment = (typeof ROUTE_SEGMENTS)[number];

export function normalizeSegment(value: unknown): RouteSegment {
  if (value === undefined || value === null) return 'driving';
  return (ROUTE_SEGMENTS as readonly unknown[]).includes(value) ? (value as RouteSegment) : 'gap';
}

/** Admin routes only: stretches undone by a save load are `reverted`. `restored` counts like `kept`. */
export const ROUTE_STATUSES = ['kept', 'reverted', 'restored'] as const;
export type RouteStatus = (typeof ROUTE_STATUSES)[number];

export function normalizeStatus(value: unknown): RouteStatus {
  return value === 'reverted' || value === 'restored' ? value : 'kept';
}

/** Legend entries other than the scale classes, in legend order. */
export const ROUTE_EXTRAS = ['uncounted', 'ferry_train', 'teleport', 'gap', 'reverted'] as const;
export type RouteExtra = (typeof ROUTE_EXTRAS)[number];

export const ROUTE_EXTRA_LABELS: Record<RouteExtra, string> = {
  uncounted: 'Faded: not counted (e.g. empty drive to pickup)',
  ferry_train: 'Ferry or train',
  teleport: 'Teleport (no distance)',
  gap: 'Missing data',
  reverted: 'Undone by a save load',
};

export const MAX_ROUTE_FEATURES = 5_000;
export const MAX_ROUTE_VERTICES = 100_000;

const lonLat = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]).rest(z.number());

const routeFeature = z.object({
  type: z.literal('Feature'),
  geometry: z.object({
    type: z.literal('LineString'),
    coordinates: z.array(lonLat).min(2),
  }),
  properties: z
    .object({
      scale_class: z.unknown().optional().transform(normalizeScaleClass),
      segment: z.unknown().optional().transform(normalizeSegment),
      counted: z.boolean().optional().default(true),
      status: z.unknown().optional().transform(normalizeStatus),
      local_scale: z.number().nullable().optional(),
    })
    .loose()
    .nullable()
    .transform(
      (p) =>
        p ?? {
          scale_class: 'unknown' as const,
          segment: 'driving' as const,
          counted: true,
          status: 'kept' as const,
        },
    ),
});

export const routeGeoJsonSchema = z
  .object({
    type: z.literal('FeatureCollection'),
    features: z.array(routeFeature).max(MAX_ROUTE_FEATURES),
  })
  .refine((fc) => fc.features.reduce((n, f) => n + f.geometry.coordinates.length, 0) <= MAX_ROUTE_VERTICES, {
    message: `route has more than ${MAX_ROUTE_VERTICES} vertices`,
  });

export type RouteGeoJson = z.infer<typeof routeGeoJsonSchema>;

const legendText = z.string().max(40);

export const routeRenderRequestSchema = z.object({
  game: z.enum(['ets2', 'ats']),
  route: routeGeoJsonSchema,
  width: z.number().int().min(320).max(2048).default(1200),
  height: z.number().int().min(240).max(2048).default(800),
  /** Optional text per class shown in the legend, e.g. distances the server reported. */
  legend: z.partialRecord(z.enum(SCALE_CLASSES), legendText).optional(),
  title: z.string().max(100).optional(),
});

export type RouteRenderRequest = z.input<typeof routeRenderRequestSchema>;
export type ParsedRouteRenderRequest = z.output<typeof routeRenderRequestSchema>;

// ---------------------------------------------------------------------------
// Speed / fuel charts

export const CHART_BAND_KINDS = ['reverted', 'pause', 'ferry', 'train', 'refuel', 'gap'] as const;

export const chartRenderRequestSchema = z.object({
  title: z.string().max(100),
  /** Unit label of the y axis, e.g. "mph" or "L". */
  unit: z.string().max(16),
  width: z.number().int().min(320).max(2048).default(1200),
  height: z.number().int().min(240).max(2048).default(500),
  /** [seconds since job start, value or null for a gap]. */
  points: z.array(z.tuple([z.number().min(0), z.number().nullable()])).min(1).max(20_000),
  thresholds: z.array(z.object({ value: z.number(), label: z.string().max(40) })).max(5).default([]),
  bands: z
    .array(z.object({ from: z.number().min(0), to: z.number().min(0), kind: z.enum(CHART_BAND_KINDS) }))
    .max(500)
    .default([]),
  markers: z.array(z.object({ t: z.number().min(0), label: z.string().max(40) })).max(50).default([]),
});

export type ChartRenderRequest = z.input<typeof chartRenderRequestSchema>;
export type ParsedChartRenderRequest = z.output<typeof chartRenderRequestSchema>;

// ---------------------------------------------------------------------------
// Request signing (HMAC-SHA256 with a shared key)

export const TIMESTAMP_HEADER = 'X-PT-Timestamp';
export const SIGNATURE_HEADER = 'X-PT-Signature';
export const SIGNATURE_TOLERANCE_SECONDS = 300;

async function signatureBase(timestamp: string, method: string, path: string, body: Uint8Array<ArrayBuffer>) {
  return `v1\n${timestamp}\n${method.toUpperCase()}\n${path}\n${await sha256Hex(body)}`;
}

async function hmac(key: string, message: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', utf8(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, utf8(message)));
}

export async function signRendererRequest(
  key: string,
  method: string,
  path: string,
  body: Uint8Array<ArrayBuffer>,
  nowSeconds: number,
): Promise<Record<string, string>> {
  const timestamp = String(Math.floor(nowSeconds));
  const signature = bytesToHex(await hmac(key, await signatureBase(timestamp, method, path, body)));
  return { [TIMESTAMP_HEADER]: timestamp, [SIGNATURE_HEADER]: signature };
}

export async function verifyRendererRequest(
  key: string,
  method: string,
  path: string,
  body: Uint8Array<ArrayBuffer>,
  timestamp: string | null | undefined,
  signature: string | null | undefined,
  nowSeconds: number,
): Promise<boolean> {
  if (!timestamp || !signature || !/^\d{1,12}$/.test(timestamp) || !/^[0-9a-f]{64}$/.test(signature)) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > SIGNATURE_TOLERANCE_SECONDS) return false;
  const expected = await hmac(key, await signatureBase(timestamp, method, path, body));
  return timingSafeEqual(expected, hexToBytes(signature)!);
}
