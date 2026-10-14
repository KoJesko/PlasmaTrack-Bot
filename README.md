# PlasmaTrack Bot

The Discord bot for PlasmaTrack, a non-commercial job tracker for Euro Truck Simulator 2 and
American Truck Simulator. There is no website: this bot is the whole player-facing product
and the whole moderator interface. It consumes the PlasmaTrack server's JSON API and webhooks.
ETS2 and ATS are never combined.

**Status:** stages 1–2 of 6 are done (see below). Stages 3–5 wait for the server's API
contract (`ADMIN_API.md`, `PUBLIC_API.md`, `WEBHOOKS.md`). What the bot needs from it is in
[docs/CONTRACT_REQUIREMENTS.md](docs/CONTRACT_REQUIREMENTS.md).

## How it fits together

```
Discord ──HTTPS interactions──▶ Worker (Cloudflare) ──queue──▶ Worker queue consumer
                                  │  answers within 3 s:            │  slow work: server API calls,
                                  │  reply, modal, or "thinking…"   │  renders, DMs; then edits the reply
                                  ▼                                 ▼
                              D1: notices, dedupe          Renderer service (any host)
                              R2: rendered PNG cache       PMTiles basemaps + MapLibre Native → PNG
```

| Package | What |
|---|---|
| `packages/core` | Platform-free logic: interaction routing, tasks, Discord REST, storage ports, renderer protocol and client. No Cloudflare or Node imports (enforced by a test). |
| `packages/worker` | Cloudflare Worker: `POST /interactions`, queue consumer, daily cleanup. The only place that knows about D1, Queues and R2 (`src/adapters.ts`). |
| `packages/renderer` | Node service that draws route maps (PMTiles + MapLibre Native) and speed/fuel charts (SVG via resvg). Runs on any host with Node 24. |

Key behaviour:
- **Discord's 3-second deadline.** Command handlers are synchronous and get no I/O, so the first response is always immediate. Anything that needs I/O replies "thinking…" and runs from the queue.
- **Moderator commands** are registered only in the PlasmaTrack guild, so they can't be used in DMs. The bot also checks the moderator role on every use.
- **Player tokens** are only ever shown ephemerally. They are never logged, queued or stored.
- **Undelivered notices** (DMs closed) are stored per Discord user and shown only to that user, ephemerally, via `/notices`.
- **Route images** colour each stretch by the server's `scale_class` and are always drawn over the vanilla map. A misaligned route is itself the sign of a 1:1 or modded map. Hidden and secret basemap features are removed before drawing. Every image carries the credits.

## Stages

| # | Stage | Status |
|---|---|---|
| 1 | Skeleton, interaction plumbing, storage ports, license audit | ✅ |
| 2 | Renderer service, renderer client with R2 cache | ✅ |
| 3 | Contract layer: vendored API contract, generated types, mock API, webhook receiver | ⏸ waiting for the contract |
| 4 | Player features: `/job`, `/leaderboard`, linking, DMs | ⏸ |
| 5 | Moderator features: review queue, approve/reject/void, bonuses, recalculation, tokens, config/manifests, revocations, Singleplayer Division | ⏸ |
| 6 | Hardening and docs | |

## Docs

- [docs/BUILD.md](docs/BUILD.md): build, test, run locally
- [docs/DEPLOY.md](docs/DEPLOY.md): Discord application, Cloudflare resources, renderer host
- [docs/TILES.md](docs/TILES.md): generating basemaps with truckermudgeon/maps
- [docs/CONTRACT_REQUIREMENTS.md](docs/CONTRACT_REQUIREMENTS.md): what the server contract must specify
- Sample config: [packages/worker/wrangler.sample.toml](packages/worker/wrangler.sample.toml), [packages/worker/.dev.vars.example](packages/worker/.dev.vars.example), [packages/renderer/renderer.env.example](packages/renderer/renderer.env.example)

## License

PolyForm Noncommercial 1.0.0 (a placeholder until licensing is settled). See `LICENSE.md`,
`NOTICE` and `THIRD_PARTY_NOTICES.md`. Map data © SCS Software; PlasmaTrack is not affiliated
with SCS Software and must stay non-commercial.
