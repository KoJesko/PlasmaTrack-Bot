import { formatJobId } from '../api/ids.ts';
import type { OutgoingMessage } from '../discord/rest.ts';
import type { NoticeKind } from '../ports.ts';
import type { PlayerNotification, RevocationCancelled, RevocationScheduled } from './events.ts';

// Player-facing DMs built from webhook events. The server's text is
// player-safe by contract; the bot only adds layout.

export interface DmContent {
  message: OutgoingMessage;
  /** Stored for `/notices` if the DM can't be delivered. */
  notice: { kind: NoticeKind; text: string };
}

const GAME_LABELS: Record<string, string> = { ets2: 'ETS2', ats: 'ATS' };
const COLOR_WARNING = 0xd62828;
const COLOR_INFO = 0x1f6feb;

export function notificationDm(n: PlayerNotification): DmContent {
  const footer = [n.job_id ? `Job ${formatJobId(n.job_id)}` : null, n.game ? (GAME_LABELS[n.game] ?? n.game) : null]
    .filter(Boolean)
    .join(' · ');
  const kind: NoticeKind =
    n.kind === 'invalid_delivery' ? 'invalid_delivery' : n.kind === 'speed_penalty_activated' ? 'speed_penalty' : 'other';
  return {
    message: {
      embeds: [
        {
          title: n.title,
          description: n.text,
          color: COLOR_WARNING,
          ...(footer ? { footer: { text: footer } } : {}),
          ...(n.happened_at && !Number.isNaN(Date.parse(n.happened_at)) ? { timestamp: n.happened_at } : {}),
        },
      ],
    },
    notice: { kind, text: noticeText(n.title, footer ? `${n.text} (${footer})` : n.text) },
  };
}

export function revocationDm(r: RevocationScheduled): DmContent {
  const label = r.target.label ?? r.target.id;
  const when = discordTime(r.effective_at);
  const description = when ? `${r.message}\n\nStops counting ${when}.` : r.message;
  const title = `Update needed: ${label}`;
  return {
    message: { embeds: [{ title, description, color: COLOR_WARNING }] },
    notice: { kind: 'revocation_scheduled', text: noticeText(title, description) },
  };
}

export function revocationCancelledDm(r: RevocationCancelled): DmContent {
  const label = r.target.label ?? r.target.id;
  const title = `No update needed: ${label}`;
  const description = `The planned stop for ${label} was cancelled. You don't need to do anything.`;
  return {
    message: { embeds: [{ title, description, color: COLOR_INFO }] },
    notice: { kind: 'revocation_cancelled', text: noticeText(title, description) },
  };
}

/** `<t:…:F> (<t:…:R>)`: Discord renders it in each reader's own time zone. */
function discordTime(iso: string): string | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const s = Math.floor(ms / 1000);
  return `<t:${s}:F> (<t:${s}:R>)`;
}

function noticeText(title: string, text: string): string {
  return `**${title}**: ${text}`.slice(0, 1500);
}
