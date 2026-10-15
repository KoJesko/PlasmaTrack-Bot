# Deploy

The bot has two parts, both on Cloudflare (Workers Paid plan): the **Worker** and the
**renderer**, a Container attached to it. Secrets never go in the repo: Worker
secrets go in Cloudflare's secret store, and renderer secrets in its environment.

## 1. Discord application

1. Create an application at https://discord.com/developers/applications and add a bot user.
2. Note the **Application ID** and **Public Key** (General Information) and the **bot token**
   (Bot → Reset Token). The token is a secret.
3. Invite the bot to the PlasmaTrack server with the `applications.commands` and `bot` scopes.
   No privileged intents are needed: the bot uses HTTP interactions only, never the Gateway.
4. Note the **server (guild) ID** and the **moderator role IDs** (Developer Mode → right-click → Copy ID).

## 2. Renderer (a Cloudflare Container)

The renderer draws maps and charts and shrinks evidence images to AVIF. It needs native code
(MapLibre Native, sharp), so it can't run inside a Worker. Instead it runs as a
[Cloudflare Container](https://developers.cloudflare.com/containers/) attached to the bot
Worker:
- **No public address and no domain:** only the bot reaches it, through the `RENDERER`
  Durable Object binding (`packages/worker/src/renderer-container.ts`).
- **Start-up:** on the first request after it stopped, the Durable Object starts it, waits
  for `/healthz`, and streams the basemaps in from the private `plasmatrack-tiles` R2
  bucket.
- **Idle stop:** it stops 30 seconds after the last request. Most maps therefore start it
  cold, which adds several seconds; images aren't urgent.
- **Instance:** `basic` (1/4 vCPU, 1 GiB), one instance. It draws one image at a time and
  queues the rest.

**Image:** `packages/renderer/Dockerfile`, built by GitHub Actions
(`.github/workflows/renderer-image.yml`), so no Docker is needed on your PC. On every push to
`main` that touches the renderer, the workflow builds the image, smoke-tests it (a map, a chart
and an AVIF), and pushes it to Cloudflare's private registry. Its summary prints the image
reference.

**One-time setup:**
1. **Token:** create a Cloudflare account API token from the "Edit Cloudflare Workers" template,
   scoped to your account. If the push step is refused, add the Containers permission.
2. **GitHub secrets:** add the token as `CLOUDFLARE_API_TOKEN` and your account ID as
   `CLOUDFLARE_ACCOUNT_ID`.
3. **Basemaps:** upload them (docs/TILES.md):

       npx wrangler r2 bucket create plasmatrack-tiles
       npx wrangler r2 object put plasmatrack-tiles/ets2.pmtiles --file <ets2.pmtiles> --remote
       npx wrangler r2 object put plasmatrack-tiles/ats.pmtiles --file <ats.pmtiles> --remote

4. **First image:** push to `main`, or run the workflow by hand. Copy the image reference into
   `[[containers]] image` in `packages/worker/wrangler.toml`, uncomment the container blocks
   there, and run `npx wrangler deploy`.

**After that:** for each new renderer image, update the image reference and deploy again.

**Elsewhere instead:** the same image runs on any Docker host. Mount the basemaps and set
`TILES_ETS2`/`TILES_ATS`, put a TLS reverse proxy in front, and set the Worker's
`RENDERER_URL` without the container blocks. Locally, `npm start -w @plasmatrack/renderer`
uses `packages/renderer/renderer.env` (docs/BUILD.md).

## 3. Cloudflare resources

Run these from the `packages/worker` folder (one command per line; works in PowerShell and POSIX shells):

    cd packages/worker
    cp wrangler.sample.toml wrangler.toml
    npx wrangler login
    npx wrangler d1 create plasmatrack-bot                 # prints the database_id
    npx wrangler queues create plasmatrack-work
    npx wrangler queues create plasmatrack-work-dlq      # messages that failed every try
    npx wrangler r2 bucket create plasmatrack-render-cache
    npx wrangler r2 bucket create plasmatrack-backups      # weekly D1 backups (OPERATIONS.md)

Now edit `wrangler.toml`: paste the `database_id`, and fill in every `[vars]` value from step 1.
Until the renderer is running, set `RENDERER_URL = "https://renderer.invalid"`. That's a
reserved name that never resolves, and nothing calls the renderer before the `/job` command
exists. Then:

    npx wrangler d1 migrations apply plasmatrack-bot --remote
    npx wrangler secret put DISCORD_BOT_TOKEN
    npx wrangler secret put RENDERER_KEY
    npx wrangler deploy

### Discord servers, roles and backends

Each Discord server the bot serves has a `[vars.GUILDS.<server id>]` table in `wrangler.toml`
(see the sample):
- **backend:** the PlasmaTrack server that Discord server uses. A test Discord server gets its
  own backend, so it never sees production data.
- **member_roles:** who can use player commands. Every command except `/about` needs a role,
  and nothing works in DMs. With no member roles, only moderators can use it there.
- **moderator_roles:** who can use moderator commands.
- **review_channel:** where review-queue posts go (`""` for none). The bot needs **View
  Channel**, **Send Messages** and **Embed Links** there. Keep the channel visible to moderators
  only: posts name the player and the review reasons.

### Connecting a PlasmaTrack server

Do this for each backend once its server is deployed. Until then, leave it without
`api_url`; commands say the server isn't connected. A test backend can use `demo = true`
(made-up data in memory) in the meantime. Below, `<NAME>` is the backend's name in capitals,
e.g. `PRODUCTION` or `TEST`.

1. **API:** set `api_url` in that backend's `[vars.BACKENDS.<name>]` table (the server's origin,
   e.g. `https://plasmatrack-server.<account>.workers.dev`), then:

       npx wrangler secret put PLASMATRACK_BOT_TOKEN_<NAME>

   The server's separate read-only token isn't used.
2. **Webhooks:**
   1. Generate a secret. Every backend needs a different one, because the secret tells the
      bot which server sent an event:

          node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"

   2. Store it on the bot:

          npx wrangler secret put PLASMATRACK_WEBHOOK_SECRET_<NAME>

   3. In that server's settings, set the same secret and the webhook URL
      `https://<this worker>/webhooks/plasmatrack` (the same URL for every backend).
   4. **To rotate:** put both secrets on each side, comma-separated on the bot. Once the
      server signs with the new one, remove the old one from both.
3. **Migrations:** apply them (`0002` orders webhook events, `0003` keeps notices per backend,
   `0004` stores moderator-issued token grants and review posts, `0005` counts slash commands
   for the rate limit, `0006` keeps `/submit` drafts):

       npx wrangler d1 migrations apply plasmatrack-bot --remote

4. **Admins:** every moderator who uses moderator commands must also be an admin on that
   backend's server, which makes the final call (server API_CONVENTIONS §2). The server's
   setup adds the first admins; `/admins add` adds more.

The Worker validates its configuration on every request. If anything is missing or still a
placeholder, it answers 500 and logs the names of the bad keys (never their values).
`[observability]` in `wrangler.toml` keeps the logs in the dashboard (Workers → Logs); watch
them live with `npx wrangler tail`.

- Add an **R2 lifecycle rule** on `plasmatrack-render-cache` (e.g. delete objects after 30
  days). Images are content-addressed, so expiry only costs a re-render.
- Messages that fail every retry go to `plasmatrack-work-dlq`. The same Worker consumes it,
  logs what was lost (kind and IDs only) and drops it.
- Check Cloudflare's current Queues, D1 and R2 limits for your plan before going live.

## 4. Connect Discord to the Worker

1. In the developer portal, set **Interactions Endpoint URL** to
   `https://<your-worker-host>/interactions`. Discord verifies it with a signed PING when you save.
2. Register the commands in every Discord server from `GUILDS` (comma-separated). From the repo
   root: `DISCORD_GUILD_ID=<id>,<id> npm run register-commands -w @plasmatrack/worker`. The bot
   must already be in each server.
3. Moderator commands are hidden from everyone except server admins by default. To let
   moderators use them, go to **Server Settings → Integrations → PlasmaTrack** and allow the
   moderator roles. You can hide the player commands from other roles there too. Either way,
   the bot checks each server's roles on every use.

## Updating

From the repo root:

    git pull
    npm install
    npm run check
    cd packages/worker
    npx wrangler d1 migrations apply plasmatrack-bot --remote
    npx wrangler deploy
    cd ../..
    npm run register-commands -w @plasmatrack/worker      # only if commands changed

Restart the renderer after pulling. Its style and protocol version
(`RENDER_PROTOCOL_VERSION`) are part of every cache key, so cached images never outlive a
style change.

## Moving off Cloudflare later

Only `packages/worker` depends on Cloudflare. A different host needs:
- an HTTP entry point that calls `handleInteraction`;
- a queue consumer that calls `processQueueMessage`;
- implementations of the ports in `packages/core/src/ports.ts`: `WorkQueue`,
  `DedupeStore`, `JobVersionStore`, `NoticeStore`, `BlobCache`, `TokenGrantStore`,
  `ReviewPostStore` and `RateLimiter` (`packages/core/src/memory.ts` shows the contract).
