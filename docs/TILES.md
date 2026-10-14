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

Work in a **separate clone of truckermudgeon/maps, outside this repository**. Its commands
(`npm run build -w packages/clis/parser`, `npx generator …`) only exist there.

**On Windows, use WSL (Ubuntu).**

- tippecanoe doesn't build on native Windows.
- Native Windows would also need Python plus Visual Studio Build Tools for the parser's C++
  addon, and Build Tools is proprietary.
- In WSL the whole chain is FOSS: gcc, Python, Node and tippecanoe.
- The game files are readable from WSL under `/mnt/c/...`.

Once, in an **administrator** PowerShell (then reboot and create the Ubuntu user):

    wsl --install -d Ubuntu-24.04

Then, inside Ubuntu:

    sudo apt update
    sudo apt install -y build-essential python3 git curl xz-utils libsqlite3-dev zlib1g-dev
    # Node 24 (official build, no admin needed)
    mkdir -p ~/.local/node
    curl -fsSL https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz | tar -xJ -C ~/.local/node --strip-components=1
    echo 'export PATH="$HOME/.local/node/bin:$PATH"' >> ~/.bashrc
    source ~/.bashrc
    # tippecanoe (BSD-2-Clause)
    git clone https://github.com/felt/tippecanoe ~/tippecanoe
    make -C ~/tippecanoe -j
    sudo make -C ~/tippecanoe install
    # truckermudgeon/maps, inside the Linux filesystem (much faster than /mnt/c)
    git clone --recurse-submodules https://github.com/truckermudgeon/maps ~/maps
    cd ~/maps
    npm install
    npm run build -w packages/clis/parser

`--recurse-submodules` matters: the parser needs its `libdeflate` submodule. In an existing
clone, run `git submodule update --init --recursive`.

Then follow its own README for the current steps. In outline:

1. Install its prerequisites, including **tippecanoe** (it writes the PMTiles files).
2. Run its parser against your ATS and ETS2 installs. You own all DLC, so the full maps are
   available.
3. Generate the map tiles for each game, one at a time (each needs several GB of memory):

       npx generator map -m usa    -i ~/parser-out/ats  -o ~/tiles   # → ats.pmtiles  (~50 MB)
       npx generator map -m europe -i ~/parser-out/ets2 -o ~/tiles   # → ets2.pmtiles (~60 MB)

4. Copy `ats.pmtiles` and `ets2.pmtiles` to the renderer host and set `TILES_ATS` /
   `TILES_ETS2` in `renderer.env`.

Don't pass `--includeHidden`.

### Game 1.61 and the parser

On 2026-10-13, the upstream parser failed on the 1.61 game files. Three small local patches in
the maps clone fixed it. They live only in that clone (`git diff` there shows them) and are
not part of this repository:

- `convert-sii-to-json.ts`: strip `/* … */` block comments from `model.stable.sii` before
  parsing it.
- `scs-archive.ts`: accept texture format 93 (B8G8R8X8 sRGB, same layout as 88).
- `def-parser.ts` (`processSpeedLimitJson`): warn and skip mismatched or unknown speed-limit
  entries instead of failing. Speed limits aren't used by the basemap.

Check whether upstream has fixed these before you regenerate. If it has, drop the local
patches.

## What the renderer expects

Checked against the generator source and real 1.61 tiles (2026-10-13):
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
- The basemap colours were checked once against real tiles. Tune them in `style.ts` if
  moderators find the roads hard to read.
