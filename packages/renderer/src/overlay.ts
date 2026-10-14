import { MAP_CREDIT_LINE, SCALE_CLASS_LABELS, SCALE_CLASSES, type ScaleClass } from '@plasmatrack/core';
import { SCALE_COLORS, type Game } from './style.ts';
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
  legend?: Partial<Record<ScaleClass, string>>;
  title?: string;
}

/** Legend (top-left) and credits (bottom-right), as a transparent SVG the size of the map. */
export function overlaySvg(o: OverlayOptions): string {
  const parts: string[] = [];
  const pad = 10;
  const row = 22;

  const header = o.title ? `${o.title} · ${GAME_NAMES[o.game]}` : GAME_NAMES[o.game];
  const entries = SCALE_CLASSES.filter((c) => o.classes.has(c)).map((c) => ({
    cls: c,
    text: o.legend?.[c] ? `${SCALE_CLASS_LABELS[c]}: ${o.legend[c]}` : SCALE_CLASS_LABELS[c],
  }));
  const boxW = Math.min(
    o.width - 2 * pad,
    Math.max(textWidth(header, 14) + 2 * pad, ...entries.map((e) => 40 + textWidth(e.text, 13) + 2 * pad)),
  );
  const boxH = pad + 20 + entries.length * row + pad / 2;
  parts.push(`<rect x="${pad}" y="${pad}" width="${boxW}" height="${boxH}" rx="6" fill="#ffffff" fill-opacity="0.88" stroke="#c4bdae"/>`);
  parts.push(`<text x="${2 * pad}" y="${pad + 19}" font-size="14" font-weight="bold" fill="#1d1d1d">${escapeXml(header)}</text>`);
  entries.forEach((e, i) => {
    const y = pad + 20 + i * row + row / 2 + 2;
    const dash = e.cls === 'unknown' ? ' stroke-dasharray="6 4"' : '';
    parts.push(`<line x1="${2 * pad}" y1="${y}" x2="${2 * pad + 28}" y2="${y}" stroke="${SCALE_COLORS[e.cls]}" stroke-width="5"${dash}/>`);
    parts.push(`<text x="${2 * pad + 36}" y="${y + 4.5}" font-size="13" fill="#1d1d1d">${escapeXml(e.text)}</text>`);
  });

  const creditW = textWidth(MAP_CREDIT_LINE, 11) + 12;
  const cx = o.width - creditW - 4;
  const cy = o.height - 20;
  parts.push(`<rect x="${cx}" y="${cy}" width="${creditW}" height="17" rx="3" fill="#ffffff" fill-opacity="0.85"/>`);
  parts.push(`<text x="${cx + 6}" y="${cy + 12.5}" font-size="11" fill="#333333">${escapeXml(MAP_CREDIT_LINE)}</text>`);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${o.width}" height="${o.height}" font-family="${FONT_FAMILY}">${parts.join('')}</svg>`;
}
