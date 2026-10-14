# Basemap tiles

Route images are drawn over basemaps that you generate yourself, from your own game install,
with [truckermudgeon/maps](https://github.com/truckermudgeon/maps). Tiles are never committed
to this repository (`*.pmtiles` is git-ignored).

## License boundaries

- truckermudgeon/maps is **GPL-3.0**. Run it as a separate tool, in its own checkout. This
  repository only reads its output files. Do not copy its code, map styles or sprites in
  here: the bot has its own style (`packages/renderer/src/style.ts`).
- Generating maps from SCS game data is allowed for modding as long as nothing is sold. So
  **PlasmaTrack must stay non-commercial.**
- Every rendered image credits SCS Software (not affiliated), truckermudgeon/maps, MapLibre
  and PMTiles.

## Generate

Follow truckermudgeon/maps' own README for the current steps. In outline:

1. Install its prerequisites, including **tippecanoe** (it writes the PMTiles files).
2. Run its parser against your ATS and ETS2 installs. You own all DLC, so the full maps are
   available.
3. Generate the map tiles for each game:

       npx generator map -m usa    -i <parser output> -o <out dir>   # → ats.pmtiles
       npx generator map -m europe -i <parser output> -o <out dir>   # → ets2.pmtiles

4. Copy `ats.pmtiles` and `ets2.pmtiles` to the renderer host and set `TILES_ATS` /
   `TILES_ETS2` in `renderer.env`.

Don't pass `--includeHidden`.

## What the renderer expects

Checked against the generator source (2026-10-13):
- **One source layer per archive, named after the game** (`ats` / `ets2`). tippecanoe names it
  after the input file.
- **Feature kinds come from a `type` property.** The style draws `mapArea` and `prefab` areas,
  `road` lines and `ferry` lines.
- **Coordinates are WGS84 lon/lat**, the same projection as the server's route GeoJSON.
- **Hidden and secret features:**
  - The generator leaves hidden roads and prefabs out by default.
  - It keeps secret ones, flagged `secret: true`.
  - The renderer removes every feature whose `hidden` or `secret` property is true
    (`STRIP_FLAGS`). It does this on the tile bytes, before MapLibre sees them, and the style
    filters them again as a second line.
- **Zoom levels:** the generator writes zooms 4–13. Routes are fitted to the image whatever
  their size. Zoomed out beyond the archive's minimum zoom, the basemap is simply absent.

If a future version of the generator changes the layer name or properties, routes still
render; only the basemap underneath goes blank. Check `GET /healthz` and look at a test render
after regenerating.

## Misaligned routes are expected

Routes from 1:1 or other modded maps don't line up with the vanilla basemap. The renderer
never moves or clips them. The mismatch, together with the per-stretch scale colours, is
what moderators look for.

## Not done yet

- **City and road labels** need glyph files generated from the bundled font. That's a later
  improvement; the legend and credits already use the bundled Noto Sans.
- The basemap colours were tuned on synthetic tiles. Adjust them in `style.ts` once real
  tiles are available.
