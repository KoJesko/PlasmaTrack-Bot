# What the bot stores

The PlasmaTrack server holds the real data: players, tokens, jobs, traces and the audit log.
The bot keeps only what it needs to deliver messages and stay fast. Everything below is per
backend, so a test server's rows never mix with production's.

## Never stored

- **Player tokens.** They are shown once, privately, and never logged, queued or saved.
  When a moderator issues one, the bot stores only a grant (who, why, when). The token is
  created when the player clicks "Get your token".
- **Message contents of commands,** other than the deferred work described below.
- **Discord interaction tokens** beyond the queue (see below). They expire after 15 minutes anyway.

## D1 database (`plasmatrack-bot`)

| Table | What | Kept |
|---|---|---|
| `notices` | DMs that couldn't be delivered (closed DMs), keyed to one Discord user. Only that user sees them, privately, with `/notices`. | `NOTICE_TTL_DAYS` (30) |
| `dedupe` | IDs of server webhooks already handled, so a resend isn't handled twice. | 7 days |
| `job_versions` | The newest version handled per job, so webhooks arriving out of order are ignored. | 7 days without updates |
| `token_grants` | Moderator-issued token grants: player, moderator, reason, dates. Never a token. | Until used, or 7 days |
| `review_posts` | Which review-channel message shows which job, so it can be edited when the job is decided. | Not purged yet |
| `rate_limits` | Slash-command counts per Discord user per 20 s window. | Purged daily |
| `manual_drafts` | A `/submit` in progress: the typed values and the server's evidence IDs, never image bytes. One per player. | 1 hour |

A daily cron (03:17 UTC) deletes expired rows.

## Evidence images (`/submit`)

- **Shrinking:** the bot downloads the attachments from Discord and the renderer shrinks them
  to WebP, removing their metadata (EXIF, including GPS). The bot uploads them straight to the
  PlasmaTrack server, which stores them. The bot keeps no copy.
- **Fallback:** if the renderer can't be reached, an image already under 5 MB is uploaded at
  full size, with its metadata blocks (EXIF, XMP, text) cut out by the bot. The pixels are
  untouched.
- **Showing them:** images come from the server's signed links (valid for an hour). They are
  downloaded and attached to the message when shown.

## R2 bucket (`plasmatrack-render-cache`)

- **Rendered route maps and charts:** keyed by a hash of what was drawn. Set a lifecycle rule
  (e.g. 30 days); expiry only costs a re-render.
- **TruckersMP lookups:** public profile data (name, linked Discord ID, ban flag) for accounts
  the tracker reported. Re-fetched after 24 hours.

## Queue (`plasmatrack-work`)

Deferred work waits here for seconds, or minutes when retrying:
- commands that need the server, the renderer or a DM, with the Discord interaction token
  needed to edit the reply;
- verified server webhooks;
- DMs to send.

After 6 failed tries a message moves to `plasmatrack-work-dlq`. There the bot logs only its
kind and IDs, never tokens or text, and drops it.

## Logs

Log lines are JSON. Before writing, the logger masks every configured secret, any field whose
name looks like a credential, and interaction tokens in Discord URLs. Workers Logs keep them
in the Cloudflare dashboard for a few days; how long depends on the plan. They include Discord
user and interaction IDs, so a user can quote the "Reference" from an error message.
