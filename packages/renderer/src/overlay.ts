import {
  MAP_CREDIT_LINE,
  ROUTE_EXTRA_LABELS,
  ROUTE_EXTRAS,
  SCALE_CLASS_LABELS,
  SCALE_CLASSES,
  type RouteExtra,
  type ScaleClass,
} from '@plasmatrack/core';
import { EXTRA_STYLES, SCALE_COLORS, type Game } from './style.ts';
import { escapeXml, FONT_FAMILY, textWidth } from './svg.ts';

export const GAME_NAMES: Record<Game, string> = {
  ets2: 'Euro Truck Simulator 2',
  ats: 'American Truck Simulator',
};

export interface OverlayOptions {
  width: number;
  height: number;
  game: Game;
  classes: ReadonlySet<ScaleClass>;
  /** Non-scale entries present on the map (ferries, gaps, uncounted…). */
  extras?: ReadonlySet<RouteExtra>;
  legend?: Partial<Record<ScaleClass, string>>;
  title?: string;
}

const PAD = 10;
const ROW = 22;

/** Legend (top-left) and credits (bottom-right), as a transparent SVG the size of the map. */
export function overlaySvg(o: OverlayOptions): string {
  const parts: string[] = [];
  const pad = PAD;
  const row = ROW;

  const header = legendHeader(o);
  const entries: { text: string; color: string; width: number; dash?: string; opacity?: number }[] = [
    ...SCALE_CLASSES.filter((c) => o.classes.has(c)).map((c) => ({
      text: o.legend?.[c] ? `${SCALE_CLASS_LABELS[c]}: ${o.legend[c]}` : SCALE_CLASS_LABELS[c],
      color: SCALE_COLORS[c],
      width: 5,
      ...(c === 'unknown' ? { dash: '6 4' } : {}),
    })),
    ...ROUTE_EXTRAS.filter((x) => o.extras?.has(x)).map((x) => {
      const s = EXTRA_STYLES[x];
      return {
        text: ROUTE_EXTRA_LABELS[x],
        color: s.color,
        width: s.width,
        ...(s.dash ? { dash: `${s.dash[0] * s.width} ${s.dash[1] * s.width}` } : {}),
        ...(s.opacity ? { opacity: s.opacity } : {}),
      };
    }),
  ];
  const { width: boxW, height: boxH } = legendBox(header, entries.map((e) => e.text), o.width);
  parts.push(`<rect x="${pad}" y="${pad}" width="${boxW}" height="${boxH}" rx="6" fill="#ffffff" fill-opacity="0.88" stroke="#c4bdae"/>`);
  parts.push(`<text x="${2 * pad}" y="${pad + 19}" font-size="14" font-weight="bold" fill="#1d1d1d">${escapeXml(header)}</text>`);
  entries.forEach((e, i) => {
    const y = pad + 20 + i * row + row / 2 + 2;
    const dash = e.dash ? ` stroke-dasharray="${e.dash}"` : '';
    const opacity = e.opacity ? ` stroke-opacity="${e.opacity}"` : '';
    parts.push(`<line x1="${2 * pad}" y1="${y}" x2="${2 * pad + 28}" y2="${y}" stroke="${e.color}" stroke-width="${e.width}"${dash}${opacity}/>`);
    parts.push(`<text x="${2 * pad + 36}" y="${y + 4.5}" font-size="13" fill="#1d1d1d">${escapeXml(e.text)}</text>`);
  });

  const creditW = textWidth(MAP_CREDIT_LINE, 11) + 12;
  const cx = o.width - creditW - 4;
  const cy = o.height - 20;
  parts.push(`<rect x="${cx}" y="${cy}" width="${creditW}" height="17" rx="3" fill="#ffffff" fill-opacity="0.85"/>`);
  parts.push(`<text x="${cx + 6}" y="${cy + 12.5}" font-size="11" fill="#333333">${escapeXml(MAP_CREDIT_LINE)}</text>`);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${o.width}" height="${o.height}" font-family="${FONT_FAMILY}">${parts.join('')}</svg>`;
}

function legendHeader(o: Pick<OverlayOptions, 'title' | 'game'>): string {
  return o.title ? `${o.title} · ${GAME_NAMES[o.game]}` : GAME_NAMES[o.game];
}

function legendBox(header: string, texts: readonly string[], imageWidth: number): { width: number; height: number } {
  return {
    width: Math.min(imageWidth - 2 * PAD, Math.max(textWidth(header, 14) + 2 * PAD, ...texts.map((t) => 40 + textWidth(t, 13) + 2 * PAD))),
    height: PAD + 20 + texts.length * ROW + PAD / 2,
  };
}

/** The legend's bottom-right corner in image pixels, so the map can keep the route clear of it. */
export function legendExtent(o: OverlayOptions): { right: number; bottom: number } {
  const texts = [
    ...SCALE_CLASSES.filter((c) => o.classes.has(c)).map((c) => (o.legend?.[c] ? `${SCALE_CLASS_LABELS[c]}: ${o.legend[c]}` : SCALE_CLASS_LABELS[c])),
    ...ROUTE_EXTRAS.filter((x) => o.extras?.has(x)).map((x) => ROUTE_EXTRA_LABELS[x]),
  ];
  const box = legendBox(legendHeader(o), texts, o.width);
  return { right: PAD + box.width, bottom: PAD + box.height };
}
