import type {
  APIApplicationCommandStringOption,
  APIModalInteractionResponseCallbackData,
  APIModalSubmitInteraction,
} from 'discord-api-types/v10';
import type { AdminApi } from '../../api/client.ts';
import { REASON_MAX, REASON_MIN } from '../../api/client.ts';
import { apiFailure, requireApi } from '../../api/errors.ts';
import { ApplicationCommandOptionType, ComponentType, MessageFlags, TextInputStyle } from '../../discord/constants.ts';
import type { OutgoingMessage } from '../../discord/rest.ts';
import type { InteractionRef, TaskDeps } from '../../interactions/types.ts';

// Shared by the moderator commands. Every moderator reply is private (owner's
// decision, 2026-10-14). The acting moderator is always the Discord user of
// the signed interaction; the server checks they are an admin.

export const NOT_ADMIN = 'The PlasmaTrack server doesn’t list you as an admin. An admin can add you with `/admins add`.';

/** The admin API acting as the interaction's user. */
export function adminFor(deps: Pick<TaskDeps, 'api'>, interaction: InteractionRef): AdminApi {
  return requireApi(deps).admin(interaction.userId);
}

/** API failures, with the moderator wording for 403. */
export function modFailure(err: unknown, notFound?: string): Error {
  return apiFailure(err, { forbidden: NOT_ADMIN, ...(notFound ? { notFound } : {}) });
}

export function privateMessage(message: OutgoingMessage): OutgoingMessage {
  return { ...message, flags: MessageFlags.Ephemeral };
}

/** Required on every slash command that changes something (API_CONVENTIONS §3). */
export const REASON_OPTION: APIApplicationCommandStringOption = {
  type: ApplicationCommandOptionType.String,
  name: 'reason',
  description: 'Why (3–1000 characters; kept in the audit log)',
  required: true,
  min_length: REASON_MIN,
  max_length: REASON_MAX,
};

/** A one-field form asking for the reason, for writes started from a button. */
export function reasonModal(customId: string, title: string): APIModalInteractionResponseCallbackData {
  return {
    custom_id: customId,
    title: title.slice(0, 45),
    components: [
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.TextInput,
            custom_id: 'reason',
            label: 'Reason (kept in the audit log)',
            style: TextInputStyle.Paragraph,
            min_length: REASON_MIN,
            max_length: REASON_MAX,
            required: true,
          },
        ],
      },
    ],
  };
}

/** A text field's value from a submitted form (classic action rows, or the newer label components). */
export function modalValue(i: APIModalSubmitInteraction, customId: string): string | undefined {
  for (const row of i.data.components as unknown as { components?: unknown[]; component?: unknown }[]) {
    const fields = row.components ?? (row.component ? [row.component] : []);
    for (const f of fields as { custom_id?: string; value?: unknown }[]) {
      if (f.custom_id === customId && typeof f.value === 'string') return f.value;
    }
  }
  return undefined;
}

/** "2026-10-19" or "2026-10-19 18:00" (UTC) → RFC 3339, or null. */
export function parseUtc(input: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/.exec(input.trim());
  if (!m) return null;
  const [, y, mo, d, h = '00', mi = '00'] = m;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
  const date = new Date(ms);
  if (Number.isNaN(ms) || date.getUTCMonth() !== Number(mo) - 1 || date.getUTCDate() !== Number(d) || Number(h) > 23 || Number(mi) > 59) return null;
  return date.toISOString();
}

/** Short, safe one-line text from unknown JSON values. */
export function brief(v: unknown, max = 60): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
