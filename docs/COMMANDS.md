# Commands

Every command works only in the Discord servers configured for the bot, never in DMs. Every
command except `/about` needs one of that server's member or moderator roles. Each Discord
server only sees its own PlasmaTrack server's data.

**Limit:** 5 slash commands per person per 20 seconds, moderators included. Buttons and forms
don't count. Past the limit, the bot asks you to wait a few seconds.

**Who sees the reply:** commands marked *public* answer in the channel unless you set
`private: True`. All other replies are only visible to you.

**Units:** distances are shown in miles, with kilometres in brackets.

## Players

| Command | Reply | What it does |
|---|---|---|
| `/about` | private | What PlasmaTrack is, its license and the map credits. Works for everyone. |
| `/token new` | private | Links your Discord account and gives you a token for the desktop tracker. If you already have one, it asks before replacing it, since the old one stops working. |
| `/token status` | private | When your token was made and last used. Never the token itself. |
| `/token revoke` | private | Stops your token from working (asks first). |
| `/name name:` | private | The name shown for you on leaderboards (2–32 characters). |
| `/notices` | private | Messages the bot couldn't DM you (for example, if your DMs are closed): invalid deliveries, speed penalties, revocation notices, and "Get your token" buttons from moderators. |
| `/profile [user]` | public | A player's points, jobs and distance per game, plus the TruckersMP accounts the tracker saw. An account is marked *confirmed* only when its TruckersMP profile shows the same Discord account. Unconfirmed accounts are only shown to the player themselves, with `private: True`. |
| `/job id:` | public | One job: outcome, points, distance by map scale, bonus, notes, and the route map. Job IDs look like `7K2M-9QXA`. |
| `/jobs game: [user]` | public | A player's finished jobs in one game, 10 per page, with Previous/Next buttons. |
| `/leaderboard game: [period] [when] [division]` | public | Rankings: all-time, a month (`2026-10`) or an ISO week (`2026-W42`), in UTC. `division` narrows it to the Singleplayer Division. |
| `/stats [user]` | public | A player's overall stats: both games together and each game, the number of jobs per outcome, and distance by map scale. |
| `/history [user] [outcome]` | public | Every finished job of a player across both games, newest first, 10 per page. Jobs submitted by hand are marked "by hand". |
| `/submit job …` | private | Submit a job by hand (see below). |
| `/submit adjusted-scale …` | private | Add a section driven at another map scale to your submission. |

### Submitting a job by hand

1. Run `/submit job` with:
   - **game**, **unit** and **fuel_unit**: `unit` (mi or km) is the unit of every distance you type; `fuel_unit` is litres, US gallons or UK gallons;
   - the **places**, **cargo_name**, **distance** (what the game logged), **fuel_used**, **damage** (%), **profit**, **truck** and **truck_model**;
   - **date_started** and **date_ended** in UTC, like `2026-10-14T07:00:00Z`;
   - an **evidence** screenshot.

   Optional:
   - **map_scale** (default ETS2 19, ATS 20);
   - **mod_names**, separated by commas;
   - a **custom_map** image;
   - for ETS2, the **UK stretch**: `uk_distance`, `uk_entry_city`, `uk_end_city` and `uk_route_evidence`, all four (a GPS route screenshot counts). It is counted at scale 15.
2. The bot checks the values. It shrinks every image to WebP (at most 1920 px, location data removed) and shows you a private preview.
3. Drove part of it on another map scale? Add it with `/submit adjusted-scale` (cities, distance, scale and a screenshot). You get a new preview.
4. Press **Send**. The job goes to the moderators as "In review"; its points are held until approved. **Cancel**, or waiting an hour, drops it.

**Who sees the images:**
- **Evidence:** moderators, and you, with the **Evidence** button under `/job`.
- **Custom map:** everyone, in `/job`, unless a moderator hides it.

## Moderators

Moderator commands need a moderator role in the Discord server, and you must also be an
admin on that server's PlasmaTrack server, which has the final say. Replies are always
private.

**Reasons:** every change needs a reason (3–1000 characters), stored in the server's audit
log. Slash commands take it as a `reason` option; buttons open a short form.

### Reviewing jobs

| Command | What it does |
|---|---|
| `/review queue [game] [outcome] [reason]` | Jobs waiting for review, oldest first. Pick one from the menu to open it. |
| `/review job id:` | Everything about one job: the route map (stretches undone by a save load are drawn faded), speed and fuel charts, review reasons, integrity checks, the rules applied, and a timeline. |
| `/review trace id:` | A download link for the job's full raw trace. |

**Buttons under a job:**

- **Approve, Reject, Void, Restore:** only the decisions allowed from the job's current state appear. These also reverse an earlier decision, for example rejecting an approved job.
- **Recalculate:** re-scores the job with the current config and bonuses.
- **Trace:** the same download link as `/review trace`.
- **Refresh:** reloads the job.

**Conflicts:** if another moderator changed the job after you opened it, your decision is refused. Refresh and look again.

**Manual jobs:** `/review job` also shows what was submitted (distances in mi and km, scale, UK and adjusted sections, fuel, damage, profit, times, truck, mods, the units the player typed) and every image.

**Review channel:** if the Discord server has one, jobs that need review are posted there with an **Open** button. A post updates when the job is decided, and finished recalculations are announced.

### Manual jobs and corrections

| Command | What it does |
|---|---|
| `/approve-manual job: [reason] [hide_map] [corrections…]` | Approves a job submitted by hand. Optionally corrects any stat in the same step: distance, map scale, UK distance, adjusted-scale distance and scale, fuel, damage, profit, times. Give `unit` with any distance and `fuel_unit` with fuel. `hide_map: True` keeps the custom map out of the public `/job`. The reason defaults to "Manual submission approved." |
| `/decline-manual job: reason:` | Rejects a job submitted by hand. The reason is required. |
| `/post-approve job: reason:` | Approves any job after all, reversing an earlier rejection. |
| `/post-decline job: reason:` | Rejects any job after all, reversing an earlier approval. |
| `/edit-job stats …` | Corrects the numbers of any job, tracked or manual: distances, scales, fuel, damage, profit, times, or the bonus (`bon_…`). |
| `/edit-job details …` | Corrects places, cargo, truck, mods, and the UK or adjusted-scale city names. |
| `/edit-job clear fields:` | Removes values: damage, profit, fuel_used, truck, truck_model, mod_names, map_scale, uk, adjusted_scale, bonus. |

Edits are kept by the server as overrides. They survive every recalculation, and setting a field back to its original value removes the edit. They never change a job's outcome. Every edit is in `/audit` as `job.edit`.

### Scoring

| Command | What it does |
|---|---|
| `/recalc job id: reason:` | Re-scores one job now. |
| `/recalc all [game]` | Re-scores every job. It first shows how many jobs would change, then asks you to confirm and give a reason. |
| `/recalc status operation:` | Progress of a running recalculation. |
| `/bonus list [game] [status]` | Bonus cargo, by status. |
| `/bonus create …` | A new bonus: a cargo ID or pattern (`med_*`), a multiplier or flat points, and a UTC window. The window is checked against when the delivery reached the server, so a player's PC clock can't move a job into it. |
| `/bonus edit id: reason: …` | Changes only the fields you give. |
| `/bonus archive id: reason:` | Stops a bonus. Jobs keep the bonus they were scored with. |

### Player accounts

| Command | What it does |
|---|---|
| `/player show user:` | Account, token dates (never the token) and TruckersMP flags. |
| `/player token issue user: reason:` | Sends the player a **Get your token** button by DM, or in `/notices` if their DMs are closed. The token is only created when they click, and you never see it. The button works for 7 days. |
| `/player token revoke user: reason:` | Stops the player's token from working. |
| `/player division user: singleplayer: reason:` | Moves a player in or out of the Singleplayer Division. |
| `/player access user: disabled: reason:` | Blocks or allows a player's uploads. Blocked players are hidden from leaderboards; their jobs are kept. |
| `/tmpflags` | TruckersMP accounts used by more than one player, and players with several accounts, with our TruckersMP check next to each. |

### Server settings

| Command | What it does |
|---|---|
| `/config list` | Published `plasmatrack.toml` versions, newest first. |
| `/config publish file: current: reason:` | Publishes a `plasmatrack.toml` (max 256 KiB). |
| `/config make-current version: reason:` | Makes an older version current again. |
| `/release list` | Published tracker releases. |
| `/release publish version: platform: file: reason:` | Publishes a release manifest (JSON, max 1 MiB). |
| `/revocation list [status]` | Revocations of releases or config versions. |
| `/revocation schedule kind: id: reason:` | Stops accepting a release or config version after 21 days. Players using it are DMed. |
| `/revocation cancel id: reason:` | Cancels one before it takes effect. |
| `/admins list` / `add` / `remove` | Who the PlasmaTrack server accepts as a moderator. |
| `/audit [job] [user] [action]` | The server's audit log, newest first. |
