import { ABOUT_TEXT } from '../credits.ts';
import type { CommandDefinition } from '../interactions/types.ts';

export const aboutCommand: CommandDefinition = {
  access: 'public',
  json: { name: 'about', description: 'About PlasmaTrack, its license and map credits' },
  handle: () => ({
    kind: 'reply',
    ephemeral: true,
    message: { embeds: [{ title: 'PlasmaTrack', description: ABOUT_TEXT }] },
  }),
};
