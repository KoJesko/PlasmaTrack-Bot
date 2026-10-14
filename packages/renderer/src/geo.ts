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

/** Pixels kept free on each side of the image. */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * The view that fits all points inside the image minus `padding` (one value
 * for every side, or per side, e.g. to keep the route clear of the legend). Routes on
 * modded maps may sit far from the vanilla map; they are fitted all the same,
 * and the basemap simply doesn't line up (that mismatch is the evidence).
 */
export function fitView(
  points: Iterable<LonLat>,
  width: number,
  height: number,
  padding: number | Insets,
  zoomRange: { min: number; max: number },
): View {
  const pad = typeof padding === 'number' ? { top: padding, right: padding, bottom: padding, left: padding } : padding;
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
  const usableW = Math.max(width - pad.left - pad.right, 1);
  const usableH = Math.max(height - pad.top - pad.bottom, 1);
  const fitted = Math.log2(Math.min(usableW / (spanX * TILE_SIZE), usableH / (spanY * TILE_SIZE)));
  const zoom = Math.max(zoomRange.min, Math.min(zoomRange.max, fitted));
  // Put the route's centre in the middle of the usable area, not of the image.
  const scale = TILE_SIZE * 2 ** zoom;
  const shiftX = (pad.left - pad.right) / 2 / scale;
  const shiftY = (pad.top - pad.bottom) / 2 / scale;
  return {
    center: unproject([(minX + maxX) / 2 - shiftX, (minY + maxY) / 2 - shiftY]),
    zoom,
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
