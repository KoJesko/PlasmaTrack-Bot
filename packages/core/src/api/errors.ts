import { RetryableError, UserFacingError, type TaskDeps } from '../interactions/types.ts';
import { ApiError, ReasonError, type PlasmaTrackApi } from './client.ts';

export const NOT_CONNECTED = 'The PlasmaTrack server isn’t connected to the bot yet.';

/** The API client, or a user-facing error if the server isn't configured. */
export function requireApi(deps: Pick<TaskDeps, 'api'>): PlasmaTrackApi {
  if (!deps.api) throw new UserFacingError(NOT_CONNECTED);
  return deps.api;
}

export interface ErrorTexts {
  /** Shown for 404 instead of the generic text, e.g. "No job with that ID." */
  notFound?: string;
  /** Shown for 403, e.g. "You're not a PlasmaTrack admin on the server." */
  forbidden?: string;
}

/**
 * Maps an API failure to what a Discord task should do: retry (network, 429,
 * 5xx) or show the user a short message. Callers handle the codes they care
 * about first and pass everything else here.
 */
export function apiFailure(err: unknown, texts: ErrorTexts = {}): Error {
  if (err instanceof ReasonError) return new UserFacingError(err.message);
  if (!(err instanceof ApiError)) return err instanceof Error ? err : new Error(String(err));
  if (err.retryable) return new RetryableError(err.message, Math.max(2, Math.ceil(err.retryAfterSeconds ?? 5)));
  // A 404 means not found even without the server's error body (seen live: an empty body).
  if (err.status === 404) return new UserFacingError(texts.notFound ?? 'Not found.');
  switch (err.code) {
    case 'not_found':
      return new UserFacingError(texts.notFound ?? 'Not found.');
    case 'forbidden':
      return new UserFacingError(texts.forbidden ?? 'The PlasmaTrack server refused that.');
    case 'invalid_transition':
      return new UserFacingError(transitionText(err.details));
    case 'conflict':
      return new UserFacingError('Someone else changed this first. Look again and retry.');
    case 'validation_failed':
      return new UserFacingError(`The server rejected that: ${fieldsText(err.details)}`);
    case 'payload_too_large':
      return new UserFacingError('That is too large for the server.');
    default:
      // unauthorized, idempotency_mismatch, bad_request, bad_response: our side is wrong; log it.
      return err;
  }
}

function transitionText(details: Record<string, unknown>): string {
  const from = typeof details['from'] === 'string' ? details['from'].replace(/_/g, ' ') : null;
  const action = typeof details['action'] === 'string' ? details['action'] : null;
  return from && action ? `A job that is ${from} can’t be given “${action}”.` : 'That isn’t allowed in the current state.';
}

function fieldsText(details: Record<string, unknown>): string {
  const fields = details['fields'];
  if (fields && typeof fields === 'object') {
    const parts = Object.entries(fields as Record<string, unknown>).map(([k, v]) => `${k}: ${String(v)}`);
    if (parts.length > 0) return parts.join('; ').slice(0, 300);
  }
  const errors = details['errors'];
  if (Array.isArray(errors) && errors.length > 0) return errors.map(String).join('; ').slice(0, 300);
  return 'invalid input.';
}
