import type { RouteRenderRequest } from '../render/protocol.ts';
import type { ServerRoute } from './schemas.ts';

// Turns the server's route GeoJSON (PUBLIC_API §4, ADMIN_API §5) into a
// renderer request. Only what the image depends on is kept, so timestamps or
// per-stretch distances don't change the cache key, and the request stays small.

export interface RouteImageOptions {
  title?: string;
  legend?: RouteRenderRequest['legend'];
  width?: number;
  height?: number;
}

/**
 * The renderer draws ferries and trains alike ("Ferry or train"), so an
 * unnamed crossing is sent as a ferry. Unknown kinds stay as they are and are
 * drawn as missing data.
 */
function segmentForRenderer(segment: string | undefined): string {
  if (segment === undefined) return 'driving';
  return segment === 'ferry_or_train' ? 'ferry' : segment;
}

export function toRouteRenderRequest(route: ServerRoute, options: RouteImageOptions = {}): RouteRenderRequest {
  const features = route.features
    .filter((f) => f.geometry.coordinates.length >= 2)
    .map((f) => ({
      type: 'Feature' as const,
      geometry: {
        type: 'LineString' as const,
        coordinates: f.geometry.coordinates.map((c) => [c[0]!, c[1]!] as [number, number]),
      },
      properties: {
        scale_class: f.properties.scale_class ?? 'unknown',
        segment: segmentForRenderer(f.properties.segment),
        counted: f.properties.counted ?? true,
        status: f.properties.status ?? 'kept',
      },
    }));
  return {
    game: route.properties.game,
    route: { type: 'FeatureCollection', features },
    ...(options.title ? { title: options.title } : {}),
    ...(options.legend ? { legend: options.legend } : {}),
    ...(options.width ? { width: options.width } : {}),
    ...(options.height ? { height: options.height } : {}),
  };
}
