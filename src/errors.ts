/**
 * What the platform's status codes mean, as types.
 *
 * The distinctions here are the ones an agent has to act on and cannot infer
 * from prose. A 409 clears on its own and is worth retrying; a 400 never does
 * and retrying it burns a turn. A 402 is a plan limit, which no amount of
 * waiting fixes and which the user — not the model — has to resolve.
 *
 * Mirrors the mapping in mandala-computer-python's `_exceptions.py`, and
 * deliberately so: two clients disagreeing about what a 402 is means the same
 * failure reads differently depending on which one you reached for.
 */
export class MandalaError extends Error {
  override name = 'MandalaError';
}

export class APIError extends MandalaError {
  override name = 'APIError';
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

/** 401 — the key is missing, malformed, or revoked. */
export class AuthenticationError extends APIError {
  override name = 'AuthenticationError';
}

/** 402 — the account's plan will not allow this. Not a retry. */
export class PlanLimitError extends APIError {
  override name = 'PlanLimitError';
}

/** 403 — the key's role on the account is too low for this route. */
export class PermissionDeniedError extends APIError {
  override name = 'PermissionDeniedError';
}

/** 404 — no such computer, snapshot, or route. */
export class NotFoundError extends APIError {
  override name = 'NotFoundError';
}

/**
 * 409 — the thing exists but is in the wrong state for this right now.
 *
 * The one status on this list that is usually temporary: a guest still booting,
 * a guest agent busy with another call, a desktop session that has not come up
 * yet. Worth retrying; the others are not.
 */
export class ConflictError extends APIError {
  override name = 'ConflictError';
}

/** 503 — a hypervisor could not be reached, so an inventory would be short. */
export class UnavailableError extends APIError {
  override name = 'UnavailableError';
}

const BY_STATUS: Record<number, typeof APIError> = {
  401: AuthenticationError,
  402: PlanLimitError,
  403: PermissionDeniedError,
  404: NotFoundError,
  409: ConflictError,
  503: UnavailableError,
};

/** Build the error for a status, with the platform's own message when it sent one. */
export function errorForStatus(status: number, message: string, body?: unknown): APIError {
  const Cls = BY_STATUS[status] ?? APIError;
  return new Cls(message, status, body);
}

/**
 * Whether an error is worth trying again without changing the request.
 *
 * Used by the wait tools, which are the only place in this server that retries
 * on a caller's behalf. Everything else surfaces the refusal, because a model
 * that can read "the guest agent is not answering yet (the computer may still be
 * booting)" is better placed to decide than a fixed policy is.
 */
export function isTransient(err: unknown): boolean {
  return err instanceof ConflictError || err instanceof UnavailableError;
}
