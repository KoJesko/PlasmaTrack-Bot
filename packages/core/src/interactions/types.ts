import type {
  APIChatInputApplicationCommandInteraction,
  APIInteraction,
  APIMessageComponentInteraction,
  APIModalInteractionResponseCallbackData,
  APIModalSubmitInteraction,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord-api-types/v10';
import type { OutgoingFile, OutgoingMessage } from '../discord/rest.ts';
import type { Logger } from '../log.ts';
import type { ImageRenderer } from '../render/client.ts';
import type { Clock, NoticeStore } from '../ports.ts';

export type Access = 'everyone' | 'moderator';

/**
 * What a handler may answer with. Handlers are synchronous and get no I/O
 * dependencies, so the first response always fits Discord's 3-second window.
 * Anything that needs I/O returns `defer` with a task that runs from the queue.
 */
export type HandlerResult =
  | { kind: 'reply'; message: OutgoingMessage; ephemeral: boolean }
  /** A modal must be the first response; it cannot follow a deferral. */
  | { kind: 'modal'; modal: APIModalInteractionResponseCallbackData }
  | { kind: 'defer'; ephemeral: boolean; task: TaskRequest }
  /** For buttons: acknowledge without a new message, then edit the message from the task. */
  | { kind: 'defer-update'; task: TaskRequest };

/** Must survive a JSON round trip (it travels through the queue). Never put player tokens here. */
export interface TaskRequest {
  name: string;
  input: unknown;
}

export interface HandlerContext<I extends APIInteraction> {
  interaction: I;
  userId: string;
}

export interface CommandDefinition {
  access: Access;
  /** Registration payload; `contexts`, `integration_types` and permissions are derived from `access`. */
  json: Omit<
    RESTPostAPIChatInputApplicationCommandsJSONBody,
    'contexts' | 'integration_types' | 'dm_permission' | 'default_member_permissions'
  >;
  handle(ctx: HandlerContext<APIChatInputApplicationCommandInteraction>): HandlerResult;
}

/** Buttons and selects; matched on the part of `custom_id` before the first `:`. */
export interface ComponentDefinition {
  prefix: string;
  access: Access;
  handle(ctx: HandlerContext<APIMessageComponentInteraction>, arg: string): HandlerResult;
}

/** Modal submissions; matched like components. */
export interface ModalDefinition {
  prefix: string;
  access: Access;
  handle(ctx: HandlerContext<APIModalSubmitInteraction>, arg: string): HandlerResult;
}

export interface InteractionHandlers {
  commands: CommandDefinition[];
  components: ComponentDefinition[];
  modals: ModalDefinition[];
}

/** The interaction fields a queued task needs to answer. The token is valid for 15 minutes. */
export interface InteractionRef {
  id: string;
  applicationId: string;
  token: string;
  userId: string;
  guildId?: string;
  receivedAt: number;
}

export type QueueMessage =
  | { type: 'interaction-task'; task: TaskRequest; interaction: InteractionRef; noticeHint: boolean }
  | { type: 'notice-hint'; interaction: InteractionRef };

/** What tasks can talk to. Implemented by `DiscordRest`; faked in tests. */
export interface DiscordSender {
  editOriginal(interactionToken: string, message: OutgoingMessage, files?: OutgoingFile[]): Promise<unknown>;
  followup(interactionToken: string, message: OutgoingMessage, files?: OutgoingFile[]): Promise<unknown>;
  sendDirectMessage(userId: string, message: OutgoingMessage): Promise<void>;
}

export interface TaskDeps {
  discord: DiscordSender;
  notices: NoticeStore;
  clock: Clock;
  logger: Logger;
  renderer: ImageRenderer;
}

export interface TaskOutput {
  message: OutgoingMessage;
  files?: OutgoingFile[];
  /** Runs only after Discord accepted the message (e.g. mark notices read). */
  afterDelivered?: () => Promise<void>;
}

export interface TaskDefinition {
  name: string;
  run(input: unknown, ctx: { interaction: InteractionRef; deps: TaskDeps }): Promise<TaskOutput>;
}

/** Thrown by a task for a failure worth retrying from the queue. */
export class RetryableError extends Error {
  override name = 'RetryableError';
  readonly delaySeconds: number;

  constructor(message: string, delaySeconds = 5) {
    super(message);
    this.delaySeconds = delaySeconds;
  }
}

/** Thrown by a task for a failure the user should see as-is (no retry). */
export class UserFacingError extends Error {
  override name = 'UserFacingError';
}
