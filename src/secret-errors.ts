/**
 * The one way an error leaves the Api from a secret-store route (OPL-5026).
 *
 * A request to `secrets` or `secrets/:id` may carry a secret value, and every
 * piece of a response is text the other end chose: a refusal's sentence, a
 * reason, a header, a redirect's Location, the text of a transport failure. A
 * filter per field kept leaking through the next field nobody had filtered, so
 * instead every error raised for these routes — an HTTP refusal, a redirect, a
 * malformed answer, a network failure, a cancellation, anything else — is
 * REBUILT here before it is thrown, from a short list of things that cannot
 * carry a value:
 *
 * - the numeric status and the request's method;
 * - a `reason` that is exactly one of the documented words;
 * - a request id in the platform's own UUID format, from the header;
 * - an `Allow` that is a comma list of HTTP method names.
 *
 * Everything else is dropped: `Location`, `WWW-Authenticate`, the body, the
 * original message and any `cause`. Each kind of error gets a fixed message
 * that names the route pattern (never the id) and the method. As a last layer,
 * a kept field that shares four or more characters with the value sent is
 * dropped too.
 *
 * The class is kept — a 404 is still a {@link NotFoundError}, a 409 a
 * {@link ConflictError}, a lost answer a {@link ConnectivityInterruptedError} —
 * so `instanceof` and {@link isTransient} answer as they would have.
 */

import {
  APIError,
  CancelledError,
  ConnectivityError,
  ConnectivityInterruptedError,
  errorForStatus,
  MandalaError,
  RedirectError,
} from './errors.js';
import { DOCUMENTED_REASONS, isRequestId, overlaps } from './secret-store.js';

/** A secret store answer that arrived and is not the documented shape. */
export class MalformedSecretAnswerError extends MandalaError {
  override name = 'MalformedSecretAnswerError';
}

/** Whether a path is one of the account's secret store routes: `secrets` or `secrets/:id`. */
export function isSecretStoreRoute(path: string): boolean {
  return /^\/?secrets(?:\/[^/]*)?\/?$/.test(path.split('?')[0]);
}

const METHOD_TOKENS: ReadonlySet<string> = new Set([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
]);

/** An `Allow` value made only of HTTP method names, comma-separated. */
export function isAllowList(v: unknown): v is string {
  if (typeof v !== 'string' || v.trim() === '') return false;
  return v.split(',').every((t) => METHOD_TOKENS.has(t.trim()));
}

/** Errors already rebuilt here, so a second pass leaves them alone. */
const SANITIZED = new WeakSet<object>();

/**
 * The error to throw in place of `err`, for a request to a secret-store route.
 *
 * `value` is the secret the request carried, when it carried one; kept fields
 * that overlap it are dropped.
 */
export function sanitizeSecretError(
  err: unknown,
  method: string,
  path: string,
  value?: string,
): Error {
  if (err !== null && typeof err === 'object' && SANITIZED.has(err)) return err as Error;
  const verb = method.toUpperCase();
  const route = /^\/?secrets\/?(?:\?.*)?$/.test(path) ? 'secrets' : 'secrets/:id';
  const where = `${verb} /${route}`;
  const change = verb !== 'GET' && verb !== 'HEAD';
  const mayHave = change
    ? ' THE CHANGE MAY HAVE BEEN MADE — read the secret back before sending it again.'
    : '';
  const keep = (v: string | undefined): string | undefined =>
    v === undefined || (value !== undefined && value !== '' && overlaps(v, value)) ? undefined : v;

  let out: Error;
  if (err instanceof APIError) {
    const reason =
      err.reason !== undefined && DOCUMENTED_REASONS.has(err.reason) ? keep(err.reason) : undefined;
    const meta = {
      requestId: isRequestId(err.requestId) ? keep(err.requestId) : undefined,
      allow: isAllowList(err.allow) ? keep(err.allow) : undefined,
      method: verb,
    };
    const said = `${where} was answered HTTP ${err.status}. The response is not shown, because a secret-store response could echo the value.`;
    out =
      err instanceof RedirectError
        ? new RedirectError(
            `${said} This client does not follow redirects; check MANDALA_BASE_URL.`,
            err.status,
            undefined,
            undefined,
            meta,
          )
        : errorForStatus(
            err.status,
            said,
            reason === undefined ? undefined : { reason },
            err.retryAfterMs,
            meta,
          );
  } else if (err instanceof MalformedSecretAnswerError) {
    out = new MalformedSecretAnswerError(
      `${where} answered with something that is not the documented secret shape (not shown).${mayHave}`,
    );
  } else if (err instanceof CancelledError) {
    out = new CancelledError(
      `${where} was cancelled before its answer arrived.${change ? ' The change may have been made.' : ''}`,
    );
  } else if (err instanceof ConnectivityInterruptedError) {
    out = new ConnectivityInterruptedError(
      `${where}: the connection was lost before the answer arrived.${mayHave}`,
    );
  } else if (err instanceof ConnectivityError) {
    out = new ConnectivityError(`${where}: the platform could not be reached.`);
  } else if (err instanceof MandalaError) {
    out = new MandalaError(`${where}: the answer could not be read (not shown).${mayHave}`);
  } else {
    out = new MandalaError(`${where} failed inside this client (details not shown).${mayHave}`);
  }
  SANITIZED.add(out);
  return out;
}

/** The secret value a request body carries, if it carries one. */
export function secretValueOf(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  const v = (body as { value?: unknown }).value;
  return typeof v === 'string' ? v : undefined;
}
