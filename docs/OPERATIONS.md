# Operations

Day-to-day tasks for whoever runs the bot. First-time setup is in [DEPLOY.md](DEPLOY.md).
Commands below run from `packages/worker` unless noted.

## Where things are

| What | Where |
|---|---|
| Worker | `plasmatrack-bot` on Cloudflare: `/interactions` (Discord), `/webhooks/plasmatrack` (servers), `/healthz` |
| Config | `packages/worker/wrangler.toml` (git-ignored; the sample is `wrangler.sample.toml`) |
| Secrets | Cloudflare's secret store (`npx wrangler secret list`) |
| Logs | Cloudflare dashboard → Workers → plasmatrack-bot → Logs; live: `npx wrangler tail` |
| Database | D1 `plasmatrack-bot` (contents: [DATA.md](DATA.md)) |
| Queues | `plasmatrack-work`, plus `plasmatrack-work-dlq` for messages that failed every try |
| Renderer | Cloudflare Container `RendererContainer` behind the Worker; images from `.github/workflows/renderer-image.yml`; basemaps in R2 `plasmatrack-tiles` |
| Backups | R2 `plasmatrack-backups`, under `d1/plasmatrack-bot/`: the two newest weekly D1 backups |

## A user reports an error

Error replies end in `(Reference: <number>)`. That number is the Discord interaction ID, and
every log line about that command carries it as `interactionId`. Search the Workers Logs for it.

| Log message | Meaning |
|---|---|
| `task failed` | A bug: an unexpected error in a command. The log line has the error. |
| `task gave up` | The server, the renderer or Discord kept failing until the last try, or until the 15-minute Discord window ran out. The user was told to try again later. |
| `message dead-lettered` | A queued message used up its retries. Only its kind and IDs are logged. |
| `rate limited` | The user sent more than 5 slash commands in 20 seconds. |
| `interaction token expired before the task ran` | The queue was badly backed up. |

## Connect, or switch, a PlasmaTrack server

Each Discord server is mapped to one backend (`backend` in its `[vars.GUILDS.<id>]` table),
and each backend to one PlasmaTrack server (`api_url` in `[vars.BACKENDS.<name>]`). To
connect one:

1. Set `api_url`, then the two secrets (`<NAME>` is the backend name in capitals):

       npx wrangler secret put PLASMATRACK_BOT_TOKEN_<NAME>
       npx wrangler secret put PLASMATRACK_WEBHOOK_SECRET_<NAME>

   The server's own setup holds both values. Every backend's webhook secret must be different.
2. `npx wrangler deploy`.
3. Check:
   - `curl https://<worker>/healthz` answers `ok`;
   - an unsigned `POST /webhooks/plasmatrack` answers `401` (it answers `503` while no
     webhook secret is set at all);
   - in Discord, `/profile` shows data from that server.
4. Add the moderators as admins on that server with `/admins add` (you must already be one).

## Add a Discord server

1. Invite the bot to it (DEPLOY.md §1).
2. Add a `[vars.GUILDS.<server id>]` table: `backend`, `member_roles`, `moderator_roles`,
   `review_channel`.
3. Run `npx wrangler deploy`.
4. Register the commands there, from the repo root:

       DISCORD_GUILD_ID=<id> npm run register-commands -w @plasmatrack/worker

5. In that server, open **Server Settings → Integrations → PlasmaTrack** and allow the moderator roles to use the moderator commands.
6. Give the bot **View Channel**, **Send Messages** and **Embed Links** in the review channel.

## Rotate secrets

| Secret | How |
|---|---|
| Discord bot token | Reset it in the developer portal, then `npx wrangler secret put DISCORD_BOT_TOKEN`. The old token stops working immediately, so do both together. |
| Webhook secret | No downtime, in this order: (1) `wrangler secret put PLASMATRACK_WEBHOOK_SECRET_<NAME>` with `new,old`; (2) set the server's `WEBHOOK_SECRETS` to `new,old` (server WEBHOOKS §2); (3) set the server to `new` only; (4) set the bot to `new` only. |
| Server bot token | The server issues it. Put the new value with `wrangler secret put PLASMATRACK_BOT_TOKEN_<NAME>`, then have the server revoke the old one. |
| Renderer key | Set the new value on the renderer and with `wrangler secret put RENDERER_KEY` at about the same time. Renders fail in between, and `/job` shows no map until both match. |

## Update the server contract

When the server session publishes contract changes, run this from the repo root:

    npm run sync-contract -- "<path to server repo>" <commit>

It copies the contract docs into `docs/contract/` and the server's real example responses
into `packages/core/test/fixtures/server-examples/`. Then:

1. Update the commit named in `docs/contract/README.md`.
2. Read the "Changes" section at the end of `API_CONVENTIONS.md`.
3. Run `npm run check`. `contract-examples.test.ts` fails if any real response no longer
   parses with the bot's schemas.

## Update the renderer

1. Push the change to `main`. The "Renderer image" workflow builds, smoke-tests and pushes the
   image; its summary shows the reference.
2. Put that reference in `[[containers]] image` in `packages/worker/wrangler.toml`.
3. Run `npx wrangler deploy`. The running container is replaced; the next request starts the
   new one.

New basemaps: upload them over the old ones (`npx wrangler r2 object put
plasmatrack-tiles/<game>.pmtiles --file … --remote`). A running container keeps the old ones
until it stops, which happens 30 s after its last request.

## Backups

Every Sunday at 03:47 UTC the Worker writes the bot's D1 tables to the private R2 bucket
`plasmatrack-backups` as one SQL file, `d1/plasmatrack-bot/<time>.sql`. It then deletes all but
the newest two. If a backup fails, it logs `backup failed` and deletes nothing. A successful
one logs `backup written` with the file name, its size and the row count per table.

**What's in it:** `notices`, `token_grants`, `review_posts`, `job_versions` and `dedupe`.
`rate_limits` and `manual_drafts` live for seconds to an hour, so they're left out.

**What isn't:**
- The players, jobs, tokens and evidence, which belong to each PlasmaTrack server and are
  backed up there.
- The render cache, which rebuilds itself.
- The basemaps, whose source files you keep.

The backups are on Cloudflare too, so they cover a deleted or damaged database, not losing the
Cloudflare account.

### Restore a backup

1. **Find the file name:** in the dashboard under R2 → plasmatrack-backups, or in the last
   `backup written` log line.
2. **Download it:**

       npx wrangler r2 object get "plasmatrack-backups/d1/plasmatrack-bot/<time>.sql" --file backup.sql --remote

3. **Only if the database itself is gone:**
   - run `npx wrangler d1 create plasmatrack-bot`;
   - put the new `database_id` in `wrangler.toml`;
   - run `npx wrangler d1 migrations apply plasmatrack-bot --remote`;
   - run `npx wrangler deploy`.
4. **Load it:**

       npx wrangler d1 execute plasmatrack-bot --remote --file backup.sql

   It replaces those five tables' rows with the backup's. Webhooks handled since the backup
   may be handled a second time, so expect a few repeated review-channel updates or DMs.

## Limits and retries

- **Slash commands:** 5 per user per 20 seconds, counted in D1. Change `COMMAND_LIMIT` and `COMMAND_WINDOW_MS` in `src/index.ts`.
- **Queue:** up to 5 retries (`max_retries`, which must match `MAX_RETRIES` in `src/index.ts`). A command still failing on its last try, or about to outlive Discord's 15-minute window, tells the user to try again later instead of leaving "thinking…".
- **Server rate limits** (`429`) and server errors are retried with the server's `Retry-After`. A `501 not_implemented` is not retried. For route maps, the bot shows the job without a map.

## Check everything locally

From the repo root, run `npm run check`. It does a secret scan of tracked files, the license audit, typechecks and all tests. CI (`.github/workflows/ci.yml`) runs the same on every push to `main` and on pull requests.
