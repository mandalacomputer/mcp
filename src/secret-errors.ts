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
  AuthenticationError,
  CancelledError,
  ConflictError,
  ConnectivityError,
  ConnectivityInterruptedError,
  CreateOnlyConflictError,
  FileExistsError,
  GatewayTimeoutError,
  MandalaError,
  MethodNotAllowedError,
  MoveRequiredError,
  NotFoundError,
  OriginResponseError,
  OriginTLSError,
  OriginUnreachableError,
  PermissionDeniedError,
  PlanLimitError,
  RangeNotSatisfiableError,
  RateLimitError,
  RedirectError,
  UnavailableError,
} from './errors.js';
import { DOCUMENTED_REASONS, isRequestId, overlaps } from './secret-store.js';

/** A secret store answer that arrived and is not the documented shape. */
export class MalformedSecretAnswerError extends MandalaError {
  override name = 'MalformedSecretAnswerError';
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

/** Which of the two store routes a canonical relative path names. */
export type SecretRoute = 'secrets' | 'secrets/:id';

/**
 * The store route a canonical path (relative to the API root, no leading
 * slash, percent-decoded) names, or `undefined`. Case-insensitive, because
 * treating a path that is not the store as if it were costs a plainer error
 * message and nothing else, while the reverse leaks.
 */
export function secretRouteOf(canonical: string): SecretRoute | undefined {
  const parts = canonical.toLowerCase().split('/').filter(Boolean);
  if (parts[0] !== 'secrets') return undefined;
  if (parts.length === 1) return 'secrets';
  if (parts.length === 2) return 'secrets/:id';
  return undefined;
}

/** Whether a path is one of the account's secret store routes, as written. */
export function isSecretStoreRoute(path: string): boolean {
  try {
    return secretRouteOf(decodeURIComponent(path.split('?')[0])) !== undefined;
  } catch {
    return true;
  }
}

/**
 * The secret a request carries, read without letting anything escape: a
 * getter that throws, a proxy, anything that is not a plain string is no value.
 */
export function secretValueOf(read: () => unknown): string | undefined {
  try {
    const body = read();
    if (body === null || typeof body !== 'object')
      return typeof body === 'string' ? body : undefined;
    const v = (body as { value?: unknown }).value;
    return typeof v === 'string' ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The error classes a secret-route error keeps, by the constructor that made
 * it. Kept by CLASS, independently of which of its fields survive redaction,
 * so {@link isTransient} gives the same answer after as before — a 409 `exists`
 * whose reason overlaps the value is still a FileExistsError.
 */
const KEPT_CLASSES: ReadonlySet<unknown> = new Set<unknown>([
  APIError,
  AuthenticationError,
  PlanLimitError,
  PermissionDeniedError,
  NotFoundError,
  MethodNotAllowedError,
  ConflictError,
  FileExistsError,
  CreateOnlyConflictError,
  RateLimitError,
  UnavailableError,
  GatewayTimeoutError,
  OriginUnreachableError,
  RedirectError,
  OriginResponseError,
  OriginTLSError,
]);

/**
 * The error to throw in place of `err`, for a request to a secret-store route.
 *
 * `value` reads the secret the request carried, if any; it is read here, under
 * this function's own guard. Never throws: if anything goes wrong while
 * rebuilding, the answer is a fixed error carrying the status and method only.
 */
export function sanitizeSecretError(
  err: unknown,
  method: string,
  route: SecretRoute,
  value: () => unknown = () => undefined,
): Error {
  const verb = safeVerb(method);
  const where = `${verb} /${route}`;
  let status: number | undefined;
  try {
    if (err !== null && typeof err === 'object' && SANITIZED.has(err)) return err as Error;
    if (err instanceof APIError && Number.isInteger(err.status)) status = err.status;
    const secret = secretValueOf(value);
    const out = rebuild(err, verb, where, secret);
    SANITIZED.add(out);
    return out;
  } catch {
    const out =
      status === undefined
        ? new MandalaError(`${where} failed (details not shown).`)
        : new APIError(
            `${where} was answered HTTP ${status} (details not shown).`,
            status,
            undefined,
            undefined,
            {
              method: verb,
            },
          );
    SANITIZED.add(out);
    return out;
  }
}

function safeVerb(method: unknown): string {
  try {
    const v = String(method).toUpperCase();
    return /^[A-Z]{1,10}$/.test(v) ? v : 'REQUEST';
  } catch {
    return 'REQUEST';
  }
}

function rebuild(err: unknown, verb: string, where: string, value: string | undefined): Error {
  const change = verb !== 'GET' && verb !== 'HEAD';
  const mayHave = change
    ? ' THE CHANGE MAY HAVE BEEN MADE — read the secret back before sending it again.'
    : '';
  const keep = (v: string | undefined): string | undefined =>
    v === undefined || (value !== undefined && value !== '' && overlaps(v, value)) ? undefined : v;

  if (err instanceof APIError) {
    const status = err.status;
    const reason =
      typeof err.reason === 'string' && DOCUMENTED_REASONS.has(err.reason)
        ? keep(err.reason)
        : undefined;
    // No Retry-After, no body, no header text beyond these three, no cause.
    const meta = {
      requestId: isRequestId(err.requestId) ? keep(err.requestId) : undefined,
      allow: isAllowList(err.allow) ? keep(err.allow) : undefined,
      method: verb,
    };
    const body = reason === undefined ? undefined : { reason };
    const said =
      err instanceof RedirectError
        ? `${where} was answered HTTP ${status}, a redirect this client does not follow; check MANDALA_BASE_URL. The response is not shown.`
        : `${where} was answered HTTP ${status}. The response is not shown, because a secret-store response could echo the value.`;
    if (err instanceof RangeNotSatisfiableError)
      return new RangeNotSatisfiableError(said, status, body, undefined, undefined, meta);
    if (err instanceof MoveRequiredError)
      return new MoveRequiredError(said, status, body, err.movePossible === true, undefined, meta);
    const Ctor = KEPT_CLASSES.has(err.constructor)
      ? (err.constructor as typeof APIError)
      : APIError;
    return new Ctor(said, status, body, undefined, meta);
  }
  if (err instanceof MalformedSecretAnswerError)
    return new MalformedSecretAnswerError(
      `${where} answered with something that is not the documented secret shape (not shown).${mayHave}`,
    );
  if (err instanceof CancelledError)
    return new CancelledError(
      `${where} was cancelled before its answer arrived.${change ? ' The change may have been made.' : ''}`,
    );
  if (err instanceof ConnectivityInterruptedError)
    return new ConnectivityInterruptedError(
      `${where}: the connection was lost before the answer arrived.${mayHave}`,
    );
  if (err instanceof ConnectivityError)
    return new ConnectivityError(`${where}: the platform could not be reached.`);
  if (err instanceof MandalaError)
    return new MandalaError(`${where}: the answer could not be read (not shown).${mayHave}`);
  return new MandalaError(`${where} failed inside this client (details not shown).${mayHave}`);
}
