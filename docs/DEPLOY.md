# Deploy

The bot has two parts: the **Worker** (Cloudflare Workers Paid plan) and the **renderer**
(any host that runs Node 24 with MapLibre Native). Secrets never go in the repo: Worker
secrets go in Cloudflare's secret store, and renderer secrets in its environment.

## 1. Discord application

1. Create an application at https://discord.com/developers/applications and add a bot user.
2. Note the **Application ID** and **Public Key** (General Information) and the **bot token**
   (Bot → Reset Token). The token is a secret.
3. Invite the bot to the PlasmaTrack server with the `applications.commands` and `bot` scopes.
   No privileged intents are needed: the bot uses HTTP interactions only, never the Gateway.
4. Note the **server (guild) ID** and the **moderator role IDs** (Developer Mode → right-click → Copy ID).

## 2. Renderer

On the host of your choice:

    git clone <this repo> plasmatrack-bot
    cd plasmatrack-bot
    npm install
    cp packages/renderer/renderer.env.example packages/renderer/renderer.env
    # RENDERER_KEY: <shared secret, at least 32 random characters; same value as the Worker's RENDERER_KEY>
    # TILES_ETS2 / TILES_ATS: your basemaps (docs/TILES.md)
    npm start -w @plasmatrack/renderer

- Put it behind a TLS-terminating reverse proxy, and keep `RENDERER_HOST=127.0.0.1` unless
  something else restricts access. Every request must carry a valid HMAC signature
  (5-minute window), so the endpoint is useless to anyone without the key.
- Run it under a process supervisor (systemd, a Windows service, a container runtime). It
  exits cleanly on SIGINT/SIGTERM.
- `GET /healthz` reports whether each game's basemap loaded.
- Sizing: a small test render took about 0.2 s on the development PC; real basemaps will be slower. Start with
  `RENDER_CONCURRENCY=2`.

**Or with Docker** (`packages/renderer/Dockerfile`, Ubuntu 24.04 with a virtual display for
MapLibre Native). Build it from the repository root:

    docker build -f packages/renderer/Dockerfile -t plasmatrack-renderer .
    docker run -d --name plasmatrack-renderer --restart unless-stopped \
      -e RENDERER_KEY=<the shared key> -p 127.0.0.1:8788:8788 \
      -v /srv/plasmatrack/tiles:/tiles:ro plasmatrack-renderer

The image expects `/tiles/ets2.pmtiles` and `/tiles/ats.pmtiles`, and has a health check on
`/healthz`. Put the same TLS reverse proxy in front of it. The image hasn't been built or run
yet; headless Linux rendering is unverified (docs/BUILD.md).

## 3. Cloudflare resources

Run these from the `packages/worker` folder (one command per line; works in PowerShell and POSIX shells):

    cd packages/worker
    cp wrangler.sample.toml wrangler.toml
    npx wrangler login
    npx wrangler d1 create plasmatrack-bot                 # prints the database_id
    npx wrangler queues create plasmatrack-work
    npx wrangler queues create plasmatrack-work-dlq      # messages that failed every try
    npx wrangler r2 bucket create plasmatrack-render-cache

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
