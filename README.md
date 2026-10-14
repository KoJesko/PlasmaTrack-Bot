# PlasmaTrack Bot

The Discord bot for PlasmaTrack, a non-commercial job tracker for Euro Truck Simulator 2 and
American Truck Simulator. There is no website: this bot is the whole player-facing product
and the whole moderator interface. It consumes the PlasmaTrack server's JSON API and webhooks.
ETS2 and ATS are never combined.

**Status:** stages 1–4 of 6 are done (see below). The bot builds against the server's API
contract v1, copied into [docs/contract/](docs/contract/). The server itself is not built
yet, so everything that talks to it is tested against an in-memory mock of that contract.

## How it fits together

```
Discord ──HTTPS interactions──▶ Worker (Cloudflare) ──queue──▶ Worker queue consumer
PlasmaTrack server ──webhooks──▶  │  answers within 3 s (Discord)   │  slow work: server API calls,
                                  │  or 10 s (server): checks the    │  renders, DMs; then edits the reply
                                  │  signature, then queues          │
                                  ▼                                 ▼
                              D1: notices, dedupe,         Renderer service (any host)
                                  job versions             PMTiles basemaps + MapLibre Native → PNG
                              R2: rendered PNG cache
```

| Package | What |
|---|---|
| `packages/core` | Platform-free logic: interaction routing, tasks, Discord REST, storage ports, renderer protocol and client, PlasmaTrack server API client, webhook verification and handling. No Cloudflare or Node imports (enforced by a test). |
| `packages/worker` | Cloudflare Worker: `POST /interactions`, `POST /webhooks/plasmatrack`, queue consumer, daily cleanup. The only place that knows about D1, Queues and R2 (`src/adapters.ts`). |
| `packages/renderer` | Node service that draws route maps (PMTiles + MapLibre Native) and speed/fuel charts (SVG via resvg). Runs on any host with Node 24. |

Key behaviour:
- **Discord's 3-second deadline.** Command handlers are synchronous and get no I/O, so the first response is always immediate. Anything that needs I/O replies "thinking…" and runs from the queue.
- **Access:** commands work only in the configured Discord servers, never in DMs. Every command except `/about` needs one of that server's member or moderator roles, checked on every use. Moderator commands need a moderator role, and the PlasmaTrack server must also list the person as an admin.
- **One backend per Discord server:** each server is mapped to its own PlasmaTrack server (production, test…), so a test server never sees production data. Webhooks tell backends apart by their signing secret; notices, dedupe and job versions are kept per backend.
- **Player tokens** are only ever shown ephemerally. They are never logged, queued or stored.
- **Replies** to `/profile`, `/job`, `/jobs` and `/leaderboard` are visible to everyone unless `private:true` is used; `/token`, `/name`, `/notices` and all moderator commands are always private.
- **Distances** are shown as the server sends them, miles first with km in brackets. The bot never converts or rounds them.
- **TruckersMP accounts** the tracker reported are checked against TruckersMP's public API: an account is shown as confirmed only when its TruckersMP profile shows the same Discord account. Unconfirmed ones are shown only to the player, privately. Lookups are cached for a day.
- **Undelivered notices** (DMs closed) are stored per Discord user and shown only to that user, ephemerally, via `/notices`.
- **Server webhooks** are verified (HMAC-SHA256, 5-minute window, two secrets during a rotation), deduplicated on `event_id`, and handled from the queue. Player notifications and revocation notices are DMed immediately: the server has already applied its 5–30 s delay.
- **Route images** colour each stretch by the server's `scale_class` and are always drawn over the vanilla map. A misaligned route is itself the sign of a 1:1 or modded map. Hidden and secret basemap features are removed before drawing. Every image carries the credits.

## Stages

| # | Stage | Status |
|---|---|---|
| 1 | Skeleton, interaction plumbing, storage ports, license audit | ✅ |
| 2 | Renderer service, renderer client with R2 cache | ✅ |
| 3 | Contract layer: vendored API contract, API client and schemas, mock API, webhook receiver, player and revocation DMs, renderer drawing for every route segment kind | ✅ |
| 4 | Player features: `/token` (new, status, revoke), `/name`, `/profile`, `/job`, `/jobs`, `/leaderboard` | ✅ |
| 5 | Moderator features: review queue, approve/reject/void, bonuses, recalculation, tokens (the player collects a moderator-issued token with a button), config/manifests, revocations, Singleplayer Division | |
| 6 | Hardening and docs | |

## Docs

- [docs/BUILD.md](docs/BUILD.md): build, test, run locally
- [docs/DEPLOY.md](docs/DEPLOY.md): Discord application, Cloudflare resources, renderer host
- [docs/TILES.md](docs/TILES.md): generating basemaps with truckermudgeon/maps
- [docs/contract/](docs/contract/): the server's API contract v1 (copied from the server repository)
- [docs/CONTRACT_REQUIREMENTS.md](docs/CONTRACT_REQUIREMENTS.md): what the bot asked of that contract
- Sample config: [packages/worker/wrangler.sample.toml](packages/worker/wrangler.sample.toml), [packages/worker/.dev.vars.example](packages/worker/.dev.vars.example), [packages/renderer/renderer.env.example](packages/renderer/renderer.env.example)

## License

PolyForm Noncommercial 1.0.0 (a placeholder until licensing is settled). See `LICENSE.md`,
`NOTICE` and `THIRD_PARTY_NOTICES.md`. Map data © SCS Software; PlasmaTrack is not affiliated
with SCS Software and must stay non-commercial.
