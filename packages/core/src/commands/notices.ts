import { MessageFlags } from '../discord/constants.ts';
import type { CommandDefinition, TaskDefinition } from '../interactions/types.ts';
import { NOTICES_TASK } from '../interactions/tasks.ts';

// Notices hold a player's Invalid / penalty / revocation messages that could
// not be DMed. They are only ever read by their owner, in an ephemeral reply.

const PAGE = 10;

export const noticesCommand: CommandDefinition = {
  access: 'member',
  json: { name: 'notices', description: 'Read your notices that could not be sent as a DM (only you can see them)' },
  handle: () => ({ kind: 'defer', ephemeral: true, task: { name: NOTICES_TASK, input: null } }),
};

export const noticesTask: TaskDefinition = {
  name: NOTICES_TASK,
  async run(_input, { interaction, deps }) {
    // Scoped to the invoking user by construction: the user ID comes from the
    // signed interaction, never from command input.
    if (!deps.backend) return { message: { content: 'You have no unread notices.', flags: MessageFlags.Ephemeral } };
    const notices = await deps.notices.listUnread(interaction.userId, deps.backend, PAGE);
    if (notices.length === 0) {
      return { message: { content: 'You have no unread notices.', flags: MessageFlags.Ephemeral } };
    }
    const lines = notices.map((n) => `• <t:${Math.floor(n.createdAt / 1000)}:f> ${n.text}`);
    const remaining = (await deps.notices.countUnread(interaction.userId, deps.backend)) - notices.length;
    return {
      message: {
        flags: MessageFlags.Ephemeral,
        embeds: [
          {
            title: 'Your notices',
            description: lines.join('\n').slice(0, 4000),
            ...(remaining > 0 ? { footer: { text: `${remaining} more — run /notices again to see them.` } } : {}),
          },
        ],
      },
      afterDelivered: () =>
        deps.notices.markRead(
          interaction.userId,
          notices.map((n) => n.id),
        ),
    };
  },
};
