# What the Discord bot needs from the server contract

**Audience:** whoever writes `docs/PUBLIC_API.md`, `docs/ADMIN_API.md` and `docs/WEBHOOKS.md` in the PlasmaTrack server repo.
**Status:** requirements only. The bot does not propose paths or field names. It builds strictly against whatever the contract defines. Each item below is something the contract must answer; "(Q)" marks an open decision.

References are to the server's `docs/PLAN.md`: §7 data model, §8 server APIs, §11 decisions.

## 0. How the bot runs (constraints the contract must fit)

- The bot is a **Cloudflare Worker using HTTP interactions only** (no Discord Gateway). It must acknowledge every Discord interaction within **3 s**. So anything that calls the server goes through a queue: the bot replies "thinking…" first, then calls the API and edits its reply (the Discord interaction token lasts 15 min).
  - **Server latency budget:** any single call should finish well inside 60 s.
  - **Discord retries:** a queue retry can repeat a call, so every mutation must be **idempotent** (see §1).
- **Memory:** the Worker has about 128 MB and should never parse a multi-MB trace in one piece (see §4).
- **Rendering happens elsewhere.** Route and chart PNGs come from the bot repo's own renderer service. The server only serves data (route GeoJSON, speed/fuel series). **This settles PLAN §12 open question 1: the server does not render PNGs.**
- **Secrets on the bot side** are Worker secrets: the bot service token and the webhook signing secret. The bot **never logs or stores player tokens**. A token is shown once, ephemerally, to its owner.

## 1. Cross-cutting

1. **API versioning** (the `/api/v1` prefix per PLAN §8) and how breaking changes are announced.
2. **Service-token auth:** the header name and scheme. Is there one token for public and admin calls, or two? The bot prefers **two tokens** (a read-only public token and an admin token), so a leaked public token can't approve jobs. (Q)
3. **Acting moderator:** the header or field that carries the acting admin's **Discord user ID** on every admin call (PLAN §8).
   - **Does the server authorize that ID itself** (users with `role = admin`)? The bot also checks a Discord role and allows admin commands only inside the guild, but the server must be the final authority. (Q)
   - If the server does authorize by Discord ID: how are admins added (bootstrap, CLI, an endpoint)?
4. **Required reason:** the field name, the minimum and maximum length (the bot enforces the same in its Discord modal; Discord caps text input at 4000 chars), and which actions require it. The bot assumes **every admin mutation**.
5. **Idempotency:** a key the bot sends on every mutation (header or field) and how long the server remembers it. The bot will send a stable key per interaction (derived from the interaction ID).
6. **Error body:** one machine-readable shape, with a stable `code`, a human `message` and optional details. It should distinguish:
   - not found;
   - forbidden (not an admin);
   - invalid transition (e.g. approving a discarded job);
   - validation error (per-field);
   - conflict or stale;
   - rate limited (with retry-after).
7. **Pagination:** one scheme for every list (cursor preferred), with a max page size. Discord shows about 10–25 items per message.
8. **Timestamps:** RFC 3339 UTC everywhere. Durations in seconds.
9. **Units and rounding in every payload:**
   - Points arrive **already floored to `points_decimals`** (e.g. `3.7`). The bot displays them as-is and computes nothing.
   - 1:1 (world) distance and in-game (odometer) distance arrive as **separate fields**, each with its unit in the field name (the `_mi` / `_km` convention of PLAN §7).
   - The bot doesn't need to know about the bobtail and World of Trucks rules. It just displays what the server reports.
10. **Game:** `ets2` / `ats` as an enum on every job, leaderboard and bonus. No endpoint ever mixes the two games.
11. **Contract tests:** an OpenAPI document (PLAN §8 says OpenAPI) that the bot can vendor and generate types from, plus **example payloads** for every response and webhook. The bot's mock server is built from them.

## 2. Linking and player tokens

12. **How a Discord user gets linked to a PlasmaTrack user** (`users.discord_user_id`, PLAN §7). (Q) Options the bot can support:
    - self-service: the player runs `/link` and the server creates or links the user for that Discord ID;
    - moderator-issued: a moderator issues a token for a Discord user;
    - both.
13. **TruckersMP account ID** (Q, open for the project owner). The plugin reads `account_id` (PLAN §6b). Will the server expose it, and may it be used for linking or verification? If yes: how it is verified (it comes from the client, so it is player-controlled), and whether it is ever shown publicly.
14. **Token issue:**
    - Is the plaintext token returned **exactly once** in the response?
    - Does issuing a new token revoke the previous one?
    - May a player rotate their own token, or only a moderator?
15. **Token revoke:** by user or by token ID. Can the bot list a user's active tokens without seeing their values (created_at, last_used_at)?
16. **Link status for a Discord ID:** linked yes/no, PlasmaTrack user ID or display name, Singleplayer Division flag, disabled flag.

## 3. Public read API (player features)

17. **Job lookup:**
    - By job ID. What does an ID look like: a short string players can type or paste?
    - By Discord user: "my recent jobs", paginated, filtered by game.
18. **Job detail (public view):**
    - game, player display name, outcome;
    - points (already floored);
    - 1:1 world distance and in-game distance;
    - cargo, source and destination (city/company), delivered time;
    - multiplayer kind;
    - speed-penalty applied (yes/no);
    - bonus applied (name and effect);
    - **distance per `scale_class`** (PLAN §8);
    - which rule results are public, with player-safe wording.
    - Must never include reverted material or admin-only reasons.
19. **Route GeoJSON (public):**
    - A FeatureCollection of LineStrings in **WGS84 lon/lat**, already projected. Split at ferries, trains, pauses, gaps **and every scale change**.
    - Each feature carries `local_scale` (number or absent) and `scale_class` ∈ {`city`, `road`, `one_to_one`, `nonstandard`, `unknown`} (PLAN §8).
    - Please also include:
      - a `segment` kind (driving / ferry / train / gap) so the renderer can draw ferries and trains differently;
      - an ordering index;
      - a bbox;
      - the maximum vertex count, or a simplification guarantee (the renderer must stay fast).
    - Confirm reverted parts are never in the public route.
20. **Leaderboards (per game only):**
    - Periods (all-time, month, week?) and their timezone. (Q)
    - Paging, ranking tie-break, the player display name.
    - Is the Singleplayer Division ranked separately or only flagged? (Q)
21. **Player stats** for a Discord user, per game (totals, job count).

## 4. Admin API (moderator features)

22. **Review queue:**
    - Jobs pending manual review **and** invalid jobs (PLAN §8), with reasons (the stable reason codes and a human text), game, player, age, and held points. Paginated, filterable by game and reason.
    - A count endpoint or field (the bot shows "N pending").
23. **Admin job detail:**
    - every rule result with details;
    - integrity (config hash, matched version, config diff, manifest result, trace-check results; PLAN §6a);
    - segments (tracked / gap / reverted / restored);
    - multiplayer kind and TruckersMP server;
    - profile_key;
    - config version used;
    - bonus set used;
    - the full audit history of the job.
24. **Speed and fuel series:**
    - Timestamps, speed (mph, world), fuel (litres).
    - Marked **reverted** ranges.
    - Pause, ferry and train windows (excluded from overspeed).
    - Detected refuel episodes; the fuel-jump timestamps that triggered review (rule 4).
    - Threshold values (`penalty_over_mph`, `invalid_over_mph`) as used for this job.
    - **Size:** please offer a **downsampled series** (e.g. max N points with min/max per bucket) for charts. Charts need about 1000 points; a raw 20 Hz trace does not fit the Worker.
25. **Full trace:**
    - Downloadable as a single file (gzip JSONL?) with a known **maximum size**. Discord bot uploads cap at about 10 MiB per message, so say what happens above that (split? a time-limited signed URL from the server?). (Q)
    - Reverted parts marked (PLAN §8).
26. **Admin route GeoJSON:** same schema as §19, but **including** reverted parts, marked as such.
27. **Approve / reject / void:**
    - The allowed source outcomes for each (e.g. `discarded` is never approvable, PLAN §6).
    - The response: the new outcome and points.
    - Is void reversible? (Q)
28. **Bonus cargo CRUD** (PLAN §7 `bonus_cargo`):
    - game, match (exact or glob), type (flat or multiplier), amount, active_from/to;
    - **timezone of the window** (PLAN §6 says server clock at delivery time);
    - list/get/create/update/delete;
    - is a deleted bonus soft-deleted, given jobs record the bonus set they used?
29. **Recalculation:**
    - For one job: synchronous?
    - For all jobs: must be **asynchronous** (returns an operation ID, a status endpoint with progress, and a completion webhook or polling). Include a dry-run with the count of affected jobs, so the bot can show "this will rescore N jobs" before the reason modal.
    - Per game?
30. **Config versions** (PLAN §6a):
    - Publish a TOML text (the bot takes it from a Discord file upload; state the maximum size). The server returns the integrity hash and the version ID.
    - List versions with the current flag. Set the current version.
31. **Release manifests:**
    - The publish format (release version, platform, entries of role/path-pattern/SHA-256).
    - List. Maximum size.
32. **Revocations** (decision 17):
    - Schedule a revocation of a release or config version.
    - Does the server compute `effective_at = announced_at + 21 days` (preferred), or does the bot send it?
    - List scheduled revocations; can one be cancelled before it takes effect?
33. **Singleplayer Division flag:** set or clear it for a user (by Discord ID or user ID), and read it.
34. **Audit log:** a read endpoint (by job, by actor, by time), so moderators can see who did what, with each reason.

## 5. Webhooks

35. **Signature:**
    - The algorithm (HMAC-SHA256 preferred) and the header names.
    - **What exactly is signed** (the preferred form is a timestamp plus the raw body, e.g. `"{timestamp}.{raw body}"`).
    - Timestamp tolerance (the bot will reject anything older than 5 min).
    - Secret rotation: can two secrets be valid during rotation?
36. **Event envelope:**
    - a unique **event ID** (the bot dedupes on it);
    - the event type;
    - `occurred_at`;
    - the payload version.
37. **Delivery:**
    - Which responses the server treats as success (the bot returns 2xx once the event is queued).
    - The retry schedule and the maximum age.
    - Is ordering guaranteed? (The bot assumes not.)
38. **Registration:**
    - How the bot's URL is registered (config on the server? an admin endpoint?) and how the secret is provisioned.
    - One URL for all events?
39. **Payload schemas** for all five events (PLAN §8):
    - `job.needs_review`: job ID, game, reasons, player.
    - `job.scored`, `job.discarded`: job ID, game, outcome, points, reason codes. The bot updates or closes review-queue messages.
    - `player.notification`:
      - the **Discord user ID** of the recipient (or a user ID the bot can resolve);
      - the kind (invalid delivery / speed penalty activated);
      - job ID, game;
      - player-safe text fields.
      - **Please state in WEBHOOKS.md that the server has already applied the random 5–30 s delay** (PLAN decision 16), so the bot sends the DM immediately. The desktop client's own delay (PLAN §6b) is separate.
    - `version.revocation_scheduled`:
      - what is revoked, `announced_at`, `effective_at` (+21 days);
      - **the recipients:** one event carrying the list of affected Discord user IDs (players whose latest session used that version), or one event per player? (Q) For large lists, the bot fans out DMs through its queue, subject to Discord rate limits.

## 6. Things the bot will NOT do (so the contract doesn't need to support them)

- No scoring, rounding, unit conversion or distance maths. Every number shown comes from the server.
- No storage of player tokens or trace data.
- **Stored notices:** notices the bot couldn't DM (the player has DMs closed) are stored **keyed by Discord user ID** with an expiry. They are shown only ephemerally to that user. They are never posted publicly.
