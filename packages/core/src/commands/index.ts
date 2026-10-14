import type { InteractionHandlers, TaskDefinition } from '../interactions/types.ts';
import { aboutCommand } from './about.ts';
import { noticesCommand, noticesTask } from './notices.ts';

export const handlers: InteractionHandlers = {
  commands: [aboutCommand, noticesCommand],
  components: [],
  modals: [],
};

export const tasks: TaskDefinition[] = [noticesTask];
