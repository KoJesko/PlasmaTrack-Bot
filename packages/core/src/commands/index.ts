import type { InteractionHandlers, TaskDefinition } from '../interactions/types.ts';
import { aboutCommand } from './about.ts';
import { downloadCommand, downloadTask, uninstallCommand, uninstallTask } from './download.ts';
import { graphCommand, graphJobTask, graphLeaderboardTask, graphPlayerTask } from './graph.ts';
import { historyCommand, historyComponent, historyTask, statsCommand, statsTask } from './history.ts';
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
import {
  approveManualCommand,
  declineManualCommand,
  editJobCommand,
  editJobTask,
  manualDecideTask,
  postApproveCommand,
  postDeclineCommand,
} from './mod/manual.ts';
import { grantComponent, playerCommand, playerTasks } from './mod/player.ts';
import { reviewCommand, reviewComponents, reviewModals, reviewTasks } from './mod/review.ts';
import { noticesCommand, noticesTask } from './notices.ts';
import { profileCommand, profileTask } from './profile.ts';
import {
  evidenceComponent,
  jobEvidenceTask,
  submitAdjustedTask,
  submitRemoveSectionTask,
  submitCancelTask,
  submitCommand,
  submitComponent,
  submitPrepareTask,
  submitSendTask,
} from './submit.ts';
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
    downloadCommand,
    uninstallCommand,
    nameCommand,
    profileCommand,
    jobCommand,
    jobsCommand,
    leaderboardCommand,
    statsCommand,
    historyCommand,
    graphCommand,
    submitCommand,
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
    approveManualCommand,
    declineManualCommand,
    postApproveCommand,
    postDeclineCommand,
    editJobCommand,
  ],
  components: [
    ...tokenComponents,
    jobsComponent,
    leaderboardComponent,
    historyComponent,
    submitComponent,
    evidenceComponent,
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
  downloadTask,
  uninstallTask,
  nameTask,
  profileTask,
  jobTask,
  jobsTask,
  leaderboardTask,
  statsTask,
  historyTask,
  graphPlayerTask,
  graphJobTask,
  graphLeaderboardTask,
  submitPrepareTask,
  submitAdjustedTask,
  submitRemoveSectionTask,
  submitSendTask,
  submitCancelTask,
  jobEvidenceTask,
  ...reviewTasks,
  ...opsTasks,
  ...playerTasks,
  manageTask,
  manualDecideTask,
  editJobTask,
];
