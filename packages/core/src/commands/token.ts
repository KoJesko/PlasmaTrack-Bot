import { ApiError, idempotencyKey } from '../api/client.ts';
import { apiFailure, requireApi } from '../api/errors.ts';
import type { TokenIssue } from '../api/schemas.ts';
import { ApplicationCommandOptionType, ButtonStyle, ComponentType, MessageFlags } from '../discord/constants.ts';
import type { OutgoingMessage } from '../discord/rest.ts';
import { UserFacingError, type CommandDefinition, type ComponentDefinition, type TaskDefinition } from '../interactions/types.ts';
import { discordTime } from './format.ts';
import { defaultDisplayName, invoker, stringOption, subcommand } from './options.ts';

// /token new | status | revoke and /name. Always private.
//
// The plaintext token exists only inside the task that asks the server for it
// and the ephemeral message that shows it: it is never queued, logged or
// stored (task inputs hold no token, and API errors never include bodies).

export const TOKEN_NEW_TASK = 'token.new';
export const TOKEN_STATUS_TASK = 'token.status';
export const TOKEN_REVOKE_TASK = 'token.revoke';
export const NAME_TASK = 'player.name';

const NOT_LINKED = 'You haven’t linked PlasmaTrack yet. Use `/token new` to get your token.';
const DISABLED = 'Your PlasmaTrack account is disabled. Ask a moderator.';

const ephemeral = (message: OutgoingMessage): OutgoingMessage => ({ ...message, flags: MessageFlags.Ephemeral });

export const tokenCommand: CommandDefinition = {
  access: 'everyone',
  json: {
    name: 'token',
    description: 'Your PlasmaTrack token for the desktop tracker (only you see the replies)',
    options: [
      { type: ApplicationCommandOptionType.Subcommand, name: 'new', description: 'Link your account, or replace your token' },
      { type: ApplicationCommandOptionType.Subcommand, name: 'status', description: 'When your token was made and last used' },
      { type: ApplicationCommandOptionType.Subcommand, name: 'revoke', description: 'Stop your token from working' },
    ],
  },
  handle: ({ interaction }) => {
    switch (subcommand(interaction)) {
      case 'new':
        return {
          kind: 'defer',
          ephemeral: true,
          task: { name: TOKEN_NEW_TASK, input: { displayName: defaultDisplayName(invoker(interaction)), confirmed: false } },
        };
      case 'status':
        return { kind: 'defer', ephemeral: true, task: { name: TOKEN_STATUS_TASK, input: null } };
      case 'revoke':
        return {
          kind: 'reply',
          ephemeral: true,
          message: confirmMessage(
            'Revoke your token? The tracker stops uploading until you set a new one. Jobs it has not uploaded stay on your PC.',
            'tok-revoke',
            'Revoke',
          ),
        };
      default:
        return { kind: 'reply', ephemeral: true, message: { content: 'Unknown subcommand.' } };
    }
  },
};

export const nameCommand: CommandDefinition = {
  access: 'everyone',
  json: {
    name: 'name',
    description: 'Change the name shown for you on PlasmaTrack leaderboards (only you see the reply)',
    options: [
      { type: ApplicationCommandOptionType.String, name: 'name', description: '2–32 characters', required: true, min_length: 2, max_length: 32 },
    ],
  },
  handle: ({ interaction }) => {
    const name = stringOption(interaction, 'name')?.trim() ?? '';
    if (name.length < 2 || name.length > 32) {
      return { kind: 'reply', ephemeral: true, message: { content: 'Names are 2–32 characters.' } };
    }
    return { kind: 'defer', ephemeral: true, task: { name: NAME_TASK, input: { name } } };
  },
};

/** Confirm buttons for /token new (when a token exists) and /token revoke. */
export const tokenComponents: ComponentDefinition[] = [
  {
    prefix: 'tok-new',
    access: 'everyone',
    handle: ({ interaction }) => ({
      kind: 'defer-update',
      task: { name: TOKEN_NEW_TASK, input: { displayName: defaultDisplayName(invoker(interaction)), confirmed: true } },
    }),
  },
  {
    prefix: 'tok-revoke',
    access: 'everyone',
    handle: () => ({ kind: 'defer-update', task: { name: TOKEN_REVOKE_TASK, input: null } }),
  },
  {
    prefix: 'tok-cancel',
    access: 'everyone',
    handle: () => ({ kind: 'update', message: { content: 'Cancelled. Nothing changed.', components: [] } }),
  },
];

function confirmMessage(text: string, confirmId: string, confirmLabel: string): OutgoingMessage {
  return {
    content: text,
    components: [
      {
        type: ComponentType.ActionRow,
        components: [
          { type: ComponentType.Button, style: ButtonStyle.Danger, custom_id: confirmId, label: confirmLabel },
          { type: ComponentType.Button, style: ButtonStyle.Secondary, custom_id: 'tok-cancel', label: 'Cancel' },
        ],
      },
    ],
  };
}

interface NewInput {
  displayName: string;
  confirmed: boolean;
}

export const tokenNewTask: TaskDefinition = {
  name: TOKEN_NEW_TASK,
  async run(input, { interaction, deps }) {
    const { displayName, confirmed } = input as NewInput;
    const api = requireApi(deps);
    // The Discord ID always comes from the signed interaction.
    const discordId = interaction.userId;
    try {
      if (!confirmed && (await api.getOwnToken(discordId))) {
        return {
          message: ephemeral(
            confirmMessage(
              'You already have a token. A new one replaces it: the old one stops working at once, so you’ll need to paste the new one into PlasmaTrack Setup.',
              'tok-new',
              'Replace my token',
            ),
          ),
        };
      }
      const issued = await api.issueOwnToken(discordId, displayName, idempotencyKey(interaction.id, 'token.new'));
      return { message: ephemeral(tokenMessage(issued)) };
    } catch (err) {
      if (err instanceof ApiError && err.code === 'forbidden') throw new UserFacingError(DISABLED);
      if (err instanceof ApiError && err.code === 'rate_limited') {
        throw new UserFacingError('You’ve made too many tokens today. Try again tomorrow.');
      }
      throw apiFailure(err);
    }
  },
};

/** Shared with the moderator-issued token button (stage 5). */
export function tokenMessage(issued: TokenIssue): OutgoingMessage {
  if (!issued.token.token) {
    // An idempotent replay: the server never returns the plaintext twice.
    return {
      content: 'Your token was created, but it couldn’t be shown. Run `/token new` again to get a fresh one.',
      components: [],
    };
  }
  const intro = issued.user.created ? 'Your PlasmaTrack account is linked. ' : '';
  return {
    content: [
      `${intro}Here is your token. **It is shown only this once**, so copy it now:`,
      '```',
      issued.token.token,
      '```',
      'Paste it into **PlasmaTrack Setup**. Keep it secret: anyone with it can upload jobs as you.',
      'Lost it? Run `/token new` for a new one (the old one then stops working).',
    ].join('\n'),
    components: [],
  };
}

export const tokenStatusTask: TaskDefinition = {
  name: TOKEN_STATUS_TASK,
  async run(_input, { interaction, deps }) {
    const api = requireApi(deps);
    const meta = await api.getOwnToken(interaction.userId).catch((err: unknown) => {
      throw apiFailure(err);
    });
    if (!meta) return { message: ephemeral({ content: NOT_LINKED }) };
    const lastUsed = meta.last_used_at ? discordTime(meta.last_used_at, 'R') : 'never';
    return {
      message: ephemeral({
        content: `Your token was made ${discordTime(meta.created_at, 'f')} and last used ${lastUsed}.`,
      }),
    };
  },
};

export const tokenRevokeTask: TaskDefinition = {
  name: TOKEN_REVOKE_TASK,
  async run(_input, { interaction, deps }) {
    const api = requireApi(deps);
    try {
      const res = await api.revokeOwnToken(interaction.userId, idempotencyKey(interaction.id, 'token.revoke'));
      const content = res.revoked_token_id
        ? 'Your token is revoked. Use `/token new` when you want to track again.'
        : 'You had no active token. Nothing changed.';
      return { message: ephemeral({ content, components: [] }) };
    } catch (err) {
      throw apiFailure(err, { notFound: NOT_LINKED });
    }
  },
};

export const nameTask: TaskDefinition = {
  name: NAME_TASK,
  async run(input, { interaction, deps }) {
    const { name } = input as { name: string };
    const api = requireApi(deps);
    try {
      await api.setOwnDisplayName(interaction.userId, name, idempotencyKey(interaction.id, 'player.name'));
      return { message: ephemeral({ content: `Done. Leaderboards now show you as **${name.replace(/[*_`~|]/g, '')}**.` }) };
    } catch (err) {
      throw apiFailure(err, { notFound: NOT_LINKED, forbidden: DISABLED });
    }
  },
};
