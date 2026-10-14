import { open, type FileHandle } from 'node:fs/promises';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { PMTiles, type RangeResponse, type Source } from 'pmtiles';
import { fromVectorTileJs } from 'vt-pbf';

export interface TileSource {
  /** Uncompressed MVT bytes, or null if the archive has no tile there. */
  getTile(z: number, x: number, y: number): Promise<Uint8Array | null>;
  readonly minZoom: number;
  readonly maxZoom: number;
}

/** Reads byte ranges of a local PMTiles archive. */
class NodeFileSource implements Source {
  private readonly path: string;
  private handle: Promise<FileHandle> | undefined;

  constructor(path: string) {
    this.path = path;
  }

  getKey(): string {
    return this.path;
  }

  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    this.handle ??= open(this.path, 'r');
    const fh = await this.handle;
    const buf = new Uint8Array(length);
    const { bytesRead } = await fh.read(buf, 0, length, offset);
    return { data: buf.buffer.slice(0, bytesRead) };
  }

  async close(): Promise<void> {
    if (this.handle) await (await this.handle).close();
  }
}

export class PMTilesFileSource implements TileSource {
  private readonly file: NodeFileSource;
  private readonly archive: PMTiles;
  minZoom = 0;
  maxZoom = 0;

  private constructor(path: string) {
    this.file = new NodeFileSource(path);
    this.archive = new PMTiles(this.file);
  }

  static async open(path: string): Promise<PMTilesFileSource> {
    const source = new PMTilesFileSource(path);
    const header = await source.archive.getHeader();
    if (header.tileType !== 1) throw new Error(`${path}: expected vector (MVT) tiles, got tile type ${header.tileType}`);
    source.minZoom = header.minZoom;
    source.maxZoom = header.maxZoom;
    return source;
  }

  async getTile(z: number, x: number, y: number): Promise<Uint8Array | null> {
    const res = await this.archive.getZxy(z, x, y);
    return res ? new Uint8Array(res.data) : null;
  }

  close(): Promise<void> {
    return this.file.close();
  }
}

/**
 * Drops every basemap feature whose property named in `flags` is truthy
 * (truckermudgeon/maps marks such features `hidden` / `secret`). Filtering
 * happens on the tile bytes before MapLibre sees them, so a style mistake
 * can't draw them. The style also filters them, as a second line.
 */
export class StrippingTileSource implements TileSource {
  private readonly inner: TileSource;
  private readonly flags: readonly string[];

  constructor(inner: TileSource, flags: readonly string[]) {
    this.inner = inner;
    this.flags = flags;
  }

  get minZoom() {
    return this.inner.minZoom;
  }

  get maxZoom() {
    return this.inner.maxZoom;
  }

  async getTile(z: number, x: number, y: number): Promise<Uint8Array | null> {
    const bytes = await this.inner.getTile(z, x, y);
    return bytes && stripFlaggedFeatures(bytes, this.flags);
  }
}

export function isFlagged(properties: Record<string, unknown>, flags: readonly string[]): boolean {
  return flags.some((f) => {
    const v = properties[f];
    return v === true || v === 1 || v === 'true' || v === '1';
  });
}

export function stripFlaggedFeatures(bytes: Uint8Array, flags: readonly string[]): Uint8Array {
  if (flags.length === 0) return bytes;
  const tile = new VectorTile(new PbfReader(bytes));
  let removed = 0;
  const layers: Record<string, unknown> = {};
  for (const [name, layer] of Object.entries(tile.layers)) {
    const keep: number[] = [];
    for (let i = 0; i < layer.length; i++) {
      if (isFlagged(layer.feature(i).properties, flags)) removed++;
      else keep.push(i);
    }
    layers[name] = {
      name: layer.name,
      version: layer.version,
      extent: layer.extent,
      length: keep.length,
      feature: (i: number) => layer.feature(keep[i]!),
    };
  }
  return removed === 0 ? bytes : fromVectorTileJs({ layers });
}
