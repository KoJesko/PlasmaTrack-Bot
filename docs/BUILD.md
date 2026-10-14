# Build, test and run locally

## Prerequisites

- **Node.js 24 LTS** or newer (https://nodejs.org). Node runs the TypeScript sources directly
  (type stripping), so neither the renderer nor the scripts need a build step.
- npm 11+ (ships with Node 24).
- For the renderer: a platform with MapLibre Native prebuilt binaries: Ubuntu 24.04
  (x64/arm64), macOS (x64/arm64) or Windows (x64/arm64). Headless rendering was verified on
  Windows 11. On headless Linux it has not been verified yet; if it fails to create a GL
  context, run it under `xvfb-run`.

No Cloudflare account is needed to build or test: the Worker tests run locally in workerd
via Miniflare.

## Install

    npm install

npm only runs install scripts it has been told to trust. The allowed ones are pinned in the
root `package.json` (`allowScripts`):
- MapLibre Native downloads its prebuilt binary;
- esbuild and workerd check their platform binaries.

If npm reports new ones after an upgrade, review them with `npm install-scripts ls` before
approving.

## Check everything

    npm run check

This runs, in order:

| Step | Command |
|---|---|
| License audit (every installed package against the FOSS allowlist) | `npm run license-audit` |
| Typecheck every package | `npm run typecheck` |
| All tests | `npm test` |

Per package:

    npm test -w @plasmatrack/core       # routing, tasks, signing, renderer client, server API client
                                        # (against an in-memory mock of the contract), webhooks (Node)
    npm test -w @plasmatrack/worker     # entry point, webhooks endpoint, D1/R2/Queues adapters (workerd)
    npm test -w @plasmatrack/renderer   # tile stripping, pixel checks on real renders, HTTP service
    npm run build -w @plasmatrack/worker  # bundle the Worker (wrangler dry run, no upload)

The renderer tests build a synthetic basemap (PMTiles) at test time. No game data is
needed or used.

## Run locally

### Renderer

    cp packages/renderer/renderer.env.example packages/renderer/renderer.env
    # set RENDERER_KEY; point TILES_ETS2 / TILES_ATS at your basemaps (docs/TILES.md), or leave them empty
    npm start -w @plasmatrack/renderer

Check it: `curl http://127.0.0.1:8788/healthz` → `{"ok":true,"basemaps":{...}}`.

### Worker

    cd packages/worker
    cp wrangler.sample.toml wrangler.toml     # fill in IDs (docs/DEPLOY.md)
    cp .dev.vars.example .dev.vars            # DISCORD_BOT_TOKEN, RENDERER_KEY (same as the renderer's)
                                              # optional, per backend: PLASMATRACK_BOT_TOKEN_<NAME>,
                                              # PLASMATRACK_WEBHOOK_SECRET_<NAME>
    npx wrangler d1 migrations apply plasmatrack-bot --local
    npx wrangler dev

`wrangler dev` uses local D1/R2/Queues. Discord must reach `/interactions` over public HTTPS,
so for an end-to-end test you need a tunnel (any provider) to the dev server. Set the
tunnel's URL + `/interactions` as the application's Interactions Endpoint URL in the Discord
developer portal. Discord sends a signed PING when you save; the bot must answer it.

### Register slash commands

    npm run register-commands -w @plasmatrack/worker -- --dry-run   # print what would be registered
    npm run register-commands -w @plasmatrack/worker                 # register

This needs `DISCORD_APPLICATION_ID`, `DISCORD_GUILD_ID` (comma-separated: the servers in
`GUILDS`) and `DISCORD_BOT_TOKEN` in the environment or in `packages/worker/.dev.vars`. Every
command is registered per server; global commands are cleared, so nothing works in DMs.

Wrangler sends anonymous usage telemetry by default; set `WRANGLER_SEND_METRICS=false`
to turn it off.
