import { zxyToTileId } from 'pmtiles';

// Minimal PMTiles v3 writer for test fixtures: uncompressed directories and
// tiles, a single root directory. Spec: https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md

export interface FixtureTile {
  z: number;
  x: number;
  y: number;
  data: Uint8Array;
}

function varint(out: number[], n: number) {
  let v = n;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
}

export function writePmtiles(
  tiles: FixtureTile[],
  meta: { minZoom: number; maxZoom: number; bounds: [number, number, number, number] },
): Uint8Array {
  const entries = tiles
    .map((t) => ({ id: zxyToTileId(t.z, t.x, t.y), data: t.data }))
    .sort((a, b) => a.id - b.id);

  const tileData: number[] = [];
  const offsets: number[] = [];
  for (const e of entries) {
    offsets.push(tileData.length);
    tileData.push(...e.data);
  }

  const dir: number[] = [];
  varint(dir, entries.length);
  let last = 0;
  for (const e of entries) {
    varint(dir, e.id - last);
    last = e.id;
  }
  for (const _ of entries) varint(dir, 1); // run lengths
  for (const e of entries) varint(dir, e.data.length);
  entries.forEach((e, i) => {
    const contiguous = i > 0 && offsets[i] === offsets[i - 1]! + entries[i - 1]!.data.length;
    varint(dir, contiguous ? 0 : offsets[i]! + 1);
  });

  const metadata = new TextEncoder().encode('{}');
  const HEADER = 127;
  const rootOffset = HEADER;
  const metaOffset = rootOffset + dir.length;
  const dataOffset = metaOffset + metadata.length;

  const header = new DataView(new ArrayBuffer(HEADER));
  'PMTiles'.split('').forEach((c, i) => header.setUint8(i, c.charCodeAt(0)));
  header.setUint8(7, 3);
  const u64 = (pos: number, v: number) => header.setBigUint64(pos, BigInt(v), true);
  u64(8, rootOffset);
  u64(16, dir.length);
  u64(24, metaOffset);
  u64(32, metadata.length);
  u64(40, 0);
  u64(48, 0);
  u64(56, dataOffset);
  u64(64, tileData.length);
  u64(72, entries.length);
  u64(80, entries.length);
  u64(88, entries.length);
  header.setUint8(96, 1); // clustered
  header.setUint8(97, 1); // internal compression: none
  header.setUint8(98, 1); // tile compression: none
  header.setUint8(99, 1); // tile type: MVT
  header.setUint8(100, meta.minZoom);
  header.setUint8(101, meta.maxZoom);
  const e7 = (v: number) => Math.round(v * 1e7);
  header.setInt32(102, e7(meta.bounds[0]), true);
  header.setInt32(106, e7(meta.bounds[1]), true);
  header.setInt32(110, e7(meta.bounds[2]), true);
  header.setInt32(114, e7(meta.bounds[3]), true);
  header.setUint8(118, meta.minZoom);
  header.setInt32(119, e7((meta.bounds[0] + meta.bounds[2]) / 2), true);
  header.setInt32(123, e7((meta.bounds[1] + meta.bounds[3]) / 2), true);

  const out = new Uint8Array(dataOffset + tileData.length);
  out.set(new Uint8Array(header.buffer), 0);
  out.set(dir, rootOffset);
  out.set(metadata, metaOffset);
  out.set(tileData, dataOffset);
  return out;
}
