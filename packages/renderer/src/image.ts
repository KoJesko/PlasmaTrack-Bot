import { COMPRESSED_MAX_EDGE, sniffImageType } from '@plasmatrack/core';
import sharp from 'sharp';

// Evidence images for manual submissions: shrunk to AVIF before the bot
// uploads them. sharp drops metadata (EXIF, including GPS) unless asked to
// keep it, so the uploaded copy carries none.

export class UnsupportedImageError extends Error {
  override name = 'UnsupportedImageError';
}

/** Big enough for any screenshot (16K × 6K); refuses decompression bombs. */
const MAX_INPUT_PIXELS = 100_000_000;

export async function compressImage(input: Uint8Array): Promise<Uint8Array> {
  if (!sniffImageType(input)) throw new UnsupportedImageError('only PNG, JPEG, WebP and AVIF are accepted');
  try {
    const out = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, animated: false, failOn: 'error' })
      .rotate() // apply the camera's orientation before the metadata is dropped
      .resize({ width: COMPRESSED_MAX_EDGE, height: COMPRESSED_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      // A middle effort: smaller than WebP, and evidence images are never urgent.
      .avif({ quality: 50, effort: 3 })
      .toBuffer();
    return new Uint8Array(out);
  } catch (err) {
    throw new UnsupportedImageError(`could not read the image: ${err instanceof Error ? err.message : String(err)}`);
  }
}
