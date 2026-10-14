// vt-pbf ships no types; only the function used here is declared.
declare module 'vt-pbf' {
  /** Serializes a tile shaped like @mapbox/vector-tile's VectorTile to protobuf bytes. */
  export function fromVectorTileJs(tile: { layers: Record<string, unknown> }): Uint8Array;
  export function fromGeojsonVt(layers: Record<string, unknown>, options?: { version?: number; extent?: number }): Uint8Array;
}
