import sharp from 'sharp';

export interface Image {
  width: number;
  height: number;
  pixel(x: number, y: number): [number, number, number];
}

export async function decodePng(png: Uint8Array): Promise<Image> {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    height: info.height,
    pixel(x, y) {
      const i = (Math.round(y) * info.width + Math.round(x)) * 3;
      return [data[i]!, data[i + 1]!, data[i + 2]!];
    },
  };
}

export function hex(color: string): [number, number, number] {
  const n = Number.parseInt(color.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function near(a: readonly number[], b: readonly number[], tolerance = 8): boolean {
  return a.every((v, i) => Math.abs(v - b[i]!) <= tolerance);
}
