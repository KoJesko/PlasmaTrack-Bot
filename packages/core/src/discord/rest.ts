import type { APIAllowedMentions, APIEmbed, APIMessageTopLevelComponent } from 'discord-api-types/v10';

// Minimal Discord REST client for an HTTP-interactions bot: no Gateway needed.

export const DISCORD_API = 'https://discord.com/api/v10';

/** Discord JSON error code: "Cannot send messages to this user" (DMs closed). */
export const CANNOT_DM_USER = 50007;

export interface OutgoingMessage {
  content?: string;
  embeds?: APIEmbed[];
  components?: APIMessageTopLevelComponent[];
  flags?: number;
  allowed_mentions?: APIAllowedMentions;
}

export interface OutgoingFile {
  name: string;
  bytes: Uint8Array<ArrayBuffer>;
  contentType: string;
  description?: string;
}

export class DiscordApiError extends Error {
  override name = 'DiscordApiError';
  readonly status: number;
  readonly code: number | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(status: number, code: number | undefined, retryAfterSeconds: number | undefined, message: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }

  /** 429, 5xx and network failures are worth retrying; other 4xx are not. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500 || this.status === 0;
  }
}

export interface DiscordRestOptions {
  applicationId: string;
  botToken: string;
  fetch?: typeof fetch;
  baseUrl?: string;
}

export class DiscordRest {
  private readonly options: DiscordRestOptions;
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string;

  constructor(options: DiscordRestOptions) {
    this.options = options;
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
    this.baseUrl = options.baseUrl ?? DISCORD_API;
  }

  /** Replaces the deferred "thinking…" reply of an interaction. */
  editOriginal(interactionToken: string, message: OutgoingMessage, files: OutgoingFile[] = []): Promise<unknown> {
    return this.send(
      'PATCH',
      `/webhooks/${this.options.applicationId}/${interactionToken}/messages/@original`,
      message,
      files,
      false,
    );
  }

  /** Adds a message after the interaction's first reply. */
  followup(interactionToken: string, message: OutgoingMessage, files: OutgoingFile[] = []): Promise<unknown> {
    return this.send('POST', `/webhooks/${this.options.applicationId}/${interactionToken}`, message, files, false);
  }

  /** Opens (or reuses) the DM channel with a user and posts there. */
  async sendDirectMessage(userId: string, message: OutgoingMessage): Promise<void> {
    const channel = (await this.send('POST', '/users/@me/channels', { recipient_id: userId }, [], true)) as {
      id: string;
    };
    await this.send('POST', `/channels/${channel.id}/messages`, message, [], true);
  }

  private async send(
    method: string,
    path: string,
    body: object,
    files: OutgoingFile[],
    authenticated: boolean,
  ): Promise<unknown> {
    const payload = 'recipient_id' in body ? body : withSafeMentions(body as OutgoingMessage);
    const headers: Record<string, string> = {};
    if (authenticated) headers['Authorization'] = `Bot ${this.options.botToken}`;

    let requestBody: string | FormData;
    if (files.length === 0) {
      headers['Content-Type'] = 'application/json';
      requestBody = JSON.stringify(payload);
    } else {
      const form = new FormData();
      const attachments = files.map((f, id) => ({ id, filename: f.name, description: f.description }));
      form.append('payload_json', JSON.stringify({ ...payload, attachments }));
      files.forEach((f, id) => form.append(`files[${id}]`, new Blob([f.bytes], { type: f.contentType }), f.name));
      requestBody = form;
    }

    let res: Response;
    try {
      res = await this.fetchFn(this.baseUrl + path, { method, headers, body: requestBody });
    } catch (err) {
      // Never include the URL: interaction URLs carry a credential.
      throw new DiscordApiError(0, undefined, undefined, `network error on ${method} ${routeLabel(path)}: ${String(err)}`);
    }
    if (res.ok) return res.status === 204 ? null : res.json();

    let code: number | undefined;
    let retryAfter: number | undefined;
    let message = `Discord ${res.status} on ${method} ${routeLabel(path)}`;
    try {
      const err = (await res.json()) as { code?: number; message?: string; retry_after?: number };
      code = err.code;
      retryAfter = err.retry_after;
      if (err.message) message += `: ${err.message}`;
    } catch {
      // non-JSON error body
    }
    if (retryAfter === undefined) {
      const header = Number(res.headers.get('Retry-After'));
      if (Number.isFinite(header) && header > 0) retryAfter = header;
    }
    throw new DiscordApiError(res.status, code, retryAfter, message);
  }
}

/** Text shown to users can include names; never let it ping anyone. */
function withSafeMentions(message: OutgoingMessage): OutgoingMessage {
  return message.allowed_mentions ? message : { ...message, allowed_mentions: { parse: [] } };
}

/** A log-safe label for a route: interaction tokens and IDs are removed. */
export function routeLabel(path: string): string {
  return path.replace(/\/webhooks\/\d+\/[^/]+/, '/webhooks/:app/:token').replace(/\d{17,20}/g, ':id');
}
