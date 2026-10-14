import type { InteractionHandlers, TaskDefinition } from '../interactions/types.ts';
import { aboutCommand } from './about.ts';
import { jobCommand, jobTask } from './job.ts';
import {
  jobsCommand,
  jobsComponent,
  jobsTask,
  leaderboardCommand,
  leaderboardComponent,
  leaderboardTask,
} from './lists.ts';
import { noticesCommand, noticesTask } from './notices.ts';
import { profileCommand, profileTask } from './profile.ts';
import {
  nameCommand,
  nameTask,
  tokenCommand,
  tokenComponents,
  tokenNewTask,
  tokenRevokeTask,
  tokenStatusTask,
} from './token.ts';

export const handlers: InteractionHandlers = {
  commands: [aboutCommand, noticesCommand, tokenCommand, nameCommand, profileCommand, jobCommand, jobsCommand, leaderboardCommand],
  components: [...tokenComponents, jobsComponent, leaderboardComponent],
  modals: [],
};

export const tasks: TaskDefinition[] = [
  noticesTask,
  tokenNewTask,
  tokenStatusTask,
  tokenRevokeTask,
  nameTask,
  profileTask,
  jobTask,
  jobsTask,
  leaderboardTask,
];
