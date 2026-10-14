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
import {
  adminsCommand,
  auditCommand,
  configCommand,
  manageComponents,
  manageTask,
  releaseCommand,
  revocationCommand,
  tmpflagsCommand,
} from './mod/manage.ts';
import { bonusCommand, opsTasks, recalcCommand, recalcComponents, recalcModals } from './mod/ops.ts';
import { grantComponent, playerCommand, playerTasks } from './mod/player.ts';
import { reviewCommand, reviewComponents, reviewModals, reviewTasks } from './mod/review.ts';
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
  commands: [
    aboutCommand,
    noticesCommand,
    tokenCommand,
    nameCommand,
    profileCommand,
    jobCommand,
    jobsCommand,
    leaderboardCommand,
    // Moderators
    reviewCommand,
    recalcCommand,
    bonusCommand,
    playerCommand,
    configCommand,
    releaseCommand,
    revocationCommand,
    adminsCommand,
    auditCommand,
    tmpflagsCommand,
  ],
  components: [
    ...tokenComponents,
    jobsComponent,
    leaderboardComponent,
    grantComponent,
    ...reviewComponents,
    ...recalcComponents,
    ...manageComponents,
  ],
  modals: [...reviewModals, ...recalcModals],
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
  ...reviewTasks,
  ...opsTasks,
  ...playerTasks,
  manageTask,
];
