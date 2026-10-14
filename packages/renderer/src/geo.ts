// Web Mercator helpers for fitting a route into the image. MapLibre renders
// 512 px tiles, so the whole world is 512·2^zoom pixels wide.

export const TILE_SIZE = 512;
export const MAX_LAT = 85.051129;

export type LonLat = readonly [number, number];

/** Lon/lat → normalized Web Mercator in [0, 1]. */
export function project([lon, lat]: LonLat): [number, number] {
  const clamped = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
  const sin = Math.sin((clamped * Math.PI) / 180);
  return [(lon + 180) / 360, 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)];
}

export function unproject([x, y]: readonly [number, number]): [number, number] {
  const lon = x * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
  return [lon, lat];
}

export interface View {
  center: [number, number];
  zoom: number;
  width: number;
  height: number;
}

/**
 * The view that fits all points with `padding` pixels on each side. Routes on
 * modded maps may sit far from the vanilla map; they are fitted all the same,
 * and the basemap simply doesn't line up (that mismatch is the evidence).
 */
export function fitView(
  points: Iterable<LonLat>,
  width: number,
  height: number,
  padding: number,
  zoomRange: { min: number; max: number },
): View {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    const [x, y] = project(p);
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  if (!Number.isFinite(minX)) return { center: [0, 0], zoom: zoomRange.min, width, height };

  const spanX = Math.max(maxX - minX, 1e-9);
  const spanY = Math.max(maxY - minY, 1e-9);
  const usableW = Math.max(width - 2 * padding, 1);
  const usableH = Math.max(height - 2 * padding, 1);
  const zoom = Math.log2(Math.min(usableW / (spanX * TILE_SIZE), usableH / (spanY * TILE_SIZE)));
  return {
    center: unproject([(minX + maxX) / 2, (minY + maxY) / 2]),
    zoom: Math.max(zoomRange.min, Math.min(zoomRange.max, zoom)),
    width,
    height,
  };
}

/** Where a lon/lat lands in the rendered image (top-left origin). */
export function toPixel(view: View, point: LonLat): [number, number] {
  const scale = TILE_SIZE * 2 ** view.zoom;
  const [cx, cy] = project(view.center);
  const [x, y] = project(point);
  return [view.width / 2 + (x - cx) * scale, view.height / 2 + (y - cy) * scale];
}
