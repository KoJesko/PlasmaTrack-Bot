import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Resvg } from '@resvg/resvg-js';

// Text is drawn with bundled Noto Sans (OFL-1.1), never system fonts, so
// images look the same on every host.

const FONT_DIR = join(import.meta.dirname, '..', 'assets', 'fonts');
export const FONT_FILES = [join(FONT_DIR, 'NotoSans-Regular.ttf'), join(FONT_DIR, 'NotoSans-Bold.ttf')];
export const FONT_FAMILY = 'Noto Sans';

// Read once at startup so a missing asset fails fast.
for (const f of FONT_FILES) readFileSync(f);

export function escapeXml(text: string): string {
  return text.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);
}

/** Rough text width for laying out boxes (Noto Sans averages ~0.55 em per character). */
export function textWidth(text: string, fontSize: number): number {
  return Math.ceil(text.length * fontSize * 0.56);
}

export function svgToPng(svg: string): Uint8Array {
  const resvg = new Resvg(svg, {
    font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: FONT_FAMILY },
  });
  return new Uint8Array(resvg.render().asPng());
}
