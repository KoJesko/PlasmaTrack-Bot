# Server API contract (vendored)

These four files are copies of the PlasmaTrack server's bot-facing contract, v1 draft.
They come from the server repository's `docs/` at commit **715b586** (2026-10-14).

| File | What |
|---|---|
| [API_CONVENTIONS.md](API_CONVENTIONS.md) | Auth, acting moderator, reason, idempotency, errors, pagination, units, IDs |
| [PUBLIC_API.md](PUBLIC_API.md) | Player self-service (link, tokens) and public reads (profiles, jobs, routes, leaderboards) |
| [ADMIN_API.md](ADMIN_API.md) | Moderator API |
| [WEBHOOKS.md](WEBHOOKS.md) | Server → bot events and their signature |

Don't edit them here. To update them:
1. Copy the files again from the server repository.
2. Change the commit above.
3. Read the "Changes" section at the end of `API_CONVENTIONS.md`.
4. Bring `packages/core/src/api/schemas.ts` and the mock (`packages/core/test/mock-api.ts`) in
   line with the changes.

The schemas are hand-written from the examples in these files. When the server publishes
`docs/openapi/bot-api.yaml`, generate them from that instead.
