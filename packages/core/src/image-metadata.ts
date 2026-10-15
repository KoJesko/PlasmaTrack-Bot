import { sniffImageType } from './media.ts';

// Removes metadata (EXIF with GPS, XMP, IPTC, text chunks) from an image
// without decoding it. Used when the renderer can't shrink an evidence image
// and the original is uploaded instead: the pixels are untouched, only the
// metadata blocks are dropped. Returns null for anything it can't parse.

export function stripImageMetadata(bytes: Uint8Array): Uint8Array<ArrayBuffer> | null {
  switch (sniffImageType(bytes)) {
    case 'image/png':
      return stripPng(bytes);
    case 'image/jpeg':
      return stripJpeg(bytes);
    case 'image/webp':
      return stripWebp(bytes);
    default:
      return null;
  }
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** PNG: drop eXIf and the text chunks (tEXt, zTXt, iTXt); keep everything else in order. */
const PNG_DROP = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);

function stripPng(b: Uint8Array): Uint8Array<ArrayBuffer> | null {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const parts: Uint8Array[] = [b.subarray(0, 8)];
  let o = 8;
  while (o + 12 <= b.length) {
    const len = view.getUint32(o);
    const type = String.fromCharCode(b[o + 4]!, b[o + 5]!, b[o + 6]!, b[o + 7]!);
    const end = o + 12 + len;
    if (end > b.length) return null;
    if (!PNG_DROP.has(type)) parts.push(b.subarray(o, end));
    o = end;
    if (type === 'IEND') return concat(parts);
  }
  return null;
}

/** JPEG: drop APP1–APP15 (EXIF, XMP, IPTC…) and comments; keep APP0 (JFIF) and the image. */
function stripJpeg(b: Uint8Array): Uint8Array<ArrayBuffer> | null {
  const parts: Uint8Array[] = [b.subarray(0, 2)];
  let o = 2;
  while (o + 4 <= b.length) {
    if (b[o] !== 0xff) return null;
    const marker = b[o + 1]!;
    // Start of scan: the rest is image data.
    if (marker === 0xda) {
      parts.push(b.subarray(o));
      return concat(parts);
    }
    const len = (b[o + 2]! << 8) | b[o + 3]!;
    const end = o + 2 + len;
    if (len < 2 || end > b.length) return null;
    const isApp = marker >= 0xe1 && marker <= 0xef;
    if (!isApp && marker !== 0xfe) parts.push(b.subarray(o, end));
    o = end;
  }
  return null;
}

/** WebP: drop the EXIF and XMP chunks and clear their flags in VP8X. */
function stripWebp(b: Uint8Array): Uint8Array<ArrayBuffer> | null {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const parts: Uint8Array[] = [];
  let o = 12;
  while (o + 8 <= b.length) {
    const type = String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);
    const len = view.getUint32(o + 4, true);
    const end = o + 8 + len + (len % 2);
    if (o + 8 + len > b.length) return null;
    if (type === 'VP8X') {
      const chunk = b.slice(o, Math.min(end, b.length));
      chunk[8] = chunk[8]! & ~(0x08 | 0x04); // EXIF and XMP present flags
      parts.push(chunk);
    } else if (type !== 'EXIF' && type !== 'XMP ') {
      parts.push(b.subarray(o, Math.min(end, b.length)));
    }
    o = end;
  }
  const body = concat(parts);
  const header = new Uint8Array(12);
  header.set(b.subarray(0, 4), 0);
  new DataView(header.buffer).setUint32(4, body.length + 4, true);
  header.set(b.subarray(8, 12), 8);
  return concat([header, body]);
}
