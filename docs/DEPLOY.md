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

## 3. Cloudflare resources

Run these from the `packages/worker` folder (one command per line; works in PowerShell and POSIX shells):

    cd packages/worker
    cp wrangler.sample.toml wrangler.toml
    npx wrangler login
    npx wrangler d1 create plasmatrack-bot                 # prints the database_id
    npx wrangler queues create plasmatrack-work
    npx wrangler r2 bucket create plasmatrack-render-cache

Now edit `wrangler.toml`: paste the `database_id`, and fill in every `[vars]` value from step 1.
Until the renderer is running, set `RENDERER_URL = "https://renderer.invalid"`. That's a
reserved name that never resolves, and nothing calls the renderer before the `/job` command
exists. Then:

    npx wrangler d1 migrations apply plasmatrack-bot --remote
    npx wrangler secret put DISCORD_BOT_TOKEN
    npx wrangler secret put RENDERER_KEY
    npx wrangler deploy

### Connecting the PlasmaTrack server

Do this once the server is deployed. Until then, leave these out; the bot works without them.

1. **API:** set `PLASMATRACK_API_URL` in `wrangler.toml` (the server's origin, e.g.
   `https://plasmatrack-server.<account>.workers.dev`), then:

       npx wrangler secret put PLASMATRACK_BOT_TOKEN

   The server's separate read-only token isn't used.
2. **Webhooks:**
   1. Generate a secret:

          node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"

   2. Store it on the bot:

          npx wrangler secret put PLASMATRACK_WEBHOOK_SECRET

   3. In the server's settings, set the same secret and the webhook URL
      `https://<this worker>/webhooks/plasmatrack`.
   4. **To rotate:** put both secrets on each side, comma-separated on the bot. Once the
      server signs with the new one, remove the old one from both.
3. **Migrations:** apply them (`0002` adds the table used to order webhook events):

       npx wrangler d1 migrations apply plasmatrack-bot --remote

4. **Admins:** every moderator who uses moderator commands must also be an admin on the
   server, which makes the final call (server API_CONVENTIONS §2). Add the first admin on the
   server host with `plasmatrack-server admin add <discord id>`.

The Worker validates its configuration on every request. If anything is missing or still a
placeholder, it answers 500 and logs the names of the bad keys (never their values). Watch
the logs with `npx wrangler tail`.

- Add an **R2 lifecycle rule** on `plasmatrack-render-cache` (e.g. delete objects after 30
  days). Images are content-addressed, so expiry only costs a re-render.
- Optionally add a dead-letter queue (`dead_letter_queue` in `wrangler.toml`) to keep messages
  that failed all retries.
- Check Cloudflare's current Queues, D1 and R2 limits for your plan before going live.

## 4. Connect Discord to the Worker

1. In the developer portal, set **Interactions Endpoint URL** to
   `https://<your-worker-host>/interactions`. Discord verifies it with a signed PING when you save.
2. Register the commands, from the repo root: `npm run register-commands -w @plasmatrack/worker`.
3. Moderator commands are hidden from everyone except server admins by default. To let
   moderators use them, go to **Server Settings → Integrations → PlasmaTrack** and allow the
   moderator role. The bot independently re-checks `MODERATOR_ROLE_IDS` on every use.

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
- implementations of the four ports in `packages/core/src/ports.ts`: `WorkQueue`,
  `DedupeStore`, `NoticeStore` and `BlobCache` (`packages/core/src/memory.ts` shows the
  contract).
