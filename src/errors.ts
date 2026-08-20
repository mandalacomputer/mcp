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

/**
 * The request was given up on before the platform answered.
 *
 * Not an API failure and not a connectivity failure, which is the whole reason
 * it has a type: an aborted fetch surfaces from the client as a bare
 * `TypeError: This operation was aborted`, and wrapping that as "could not
 * reach <host>" told every reader the platform was down when in fact the caller
 * had hung up. A cancellation is also the one failure here where the request
 * may well have been received and acted on, so the message says so rather than
 * claiming nothing happened.
 *
 * Deliberately not transient: retrying something nobody is waiting for is the
 * behaviour `with(signal)` exists to stop.
 */
export class CancelledError extends MandalaError {
  override name = 'CancelledError';
}

/** The platform could not be reached at all. Safe for a wait loop to retry. */
export class ConnectivityError extends MandalaError {
  override name = 'ConnectivityError';
}

/**
 * 504, 524 — a proxy in front of the platform gave up before the platform answered.
 *
 * Not a refusal. The request arrived, is very likely still running, and nothing
 * was cancelled; what ended was one hop's willingness to hold a connection open
 * with no response crossing it.
 *
 * One class, two retry answers, and {@link isTransient} keeps them apart by
 * status rather than by type on purpose. A 504 is retryable and a 524 is not,
 * because of where each is reachable from: the wait tools are the only thing
 * here that retries, they poll with short requests, and a 504 on one of those
 * is infrastructure noise that clears. A 524 is only ever reached by holding a
 * request open past the ceiling below — so retrying it unchanged reproduces it
 * exactly, at the same place, because the hop that gave up never saw how long
 * the caller asked to wait.
 *
 * Against `app.mandala.computer` that hop is Cloudflare and the ceiling is about
 * two minutes. Measured 2026-08-20: `sleep 130` died at 125.2s with
 * `timeout_s: 300` and at 125.3s with `timeout_s: 3600`, while `sleep 110`
 * returned normally at 110.6s. A foreground `exec` slower than that always ends
 * here; `background: true` is the shape that does not, because it answers as
 * soon as the command has started.
 *
 * The abandoned command keeps running, which is why the next call on the same
 * computer often raises {@link ConflictError} — the guest agent is still busy
 * with it. That is this failure continuing, not a second one.
 */
export class GatewayTimeoutError extends APIError {
  override name = 'GatewayTimeoutError';
}

/**
 * 520-523, 525, 526 — a proxy in front of the platform could not reach it.
 *
 * The rest of what an edge generates on its own, and the same bug as
 * {@link GatewayTimeoutError} a few statuses along: with no class and no written
 * message these fell through to the bare `HTTP 522`, which names no cause, no
 * culprit and no way out — the exact reading that cost the debugging above.
 *
 * A different event from a gateway timeout, which is why it is a different type
 * rather than more entries on that one. A 524 means the request arrived and is
 * still being worked on; these mean it never arrived at all, so nothing was
 * started and there is no command outliving anything. A caller branching on the
 * class to decide whether its work survived gets opposite answers, correctly.
 *
 * Deliberately absent from mandala-computer-python's `_exceptions.py`, which
 * this file otherwise mirrors. That mapping is of the platform's own statuses;
 * these belong to whatever is deployed in front of it. The divergence is worth
 * it here because this client's messages are read by a model, which cannot go
 * and look up what a 523 is.
 */
export class OriginUnreachableError extends APIError {
  override name = 'OriginUnreachableError';
}

/**
 * 520 — the platform answered a proxy with something it could not read.
 *
 * Sits between the other two and must not be filed with either, because the
 * question a caller is really asking is whether their work happened, and this is
 * the one status whose honest answer is "unknown".
 *
 * A 524 means the request arrived and is still being worked on. 521-523 mean it
 * never arrived, so nothing was started. A 520 means it **did** arrive — the
 * platform received it and then returned an empty, unknown or oversized
 * response, so it may have been carried out in full, in part, or not at all, and
 * the answer was lost rather than never produced.
 *
 * Which makes a blind retry the thing to be careful about, and a model the
 * likeliest caller to attempt one. Re-sending a read costs nothing; re-sending a
 * create can leave two computers where one was meant, both billable, on the
 * strength of a failure that said the first never happened.
 *
 * It was filed with {@link OriginUnreachableError} at first, on the reading that
 * the whole 52x range is the edge failing to reach the platform. It is not, and
 * the message that came with it — "the request never arrived, so nothing was
 * started" — was exactly the confident falsehood this work exists to remove,
 * pointed the other way. Caught by a review of the Python SDK, which had
 * inherited the same grouping from this file.
 */
export class OriginResponseError extends APIError {
  override name = 'OriginResponseError';
}

/**
 * 525, 526 — a proxy and the platform could not agree on TLS.
 *
 * Split from {@link OriginUnreachableError}, which it used to share, because the
 * two need opposite answers to "should I try again". An unreachable origin is a
 * passing outage; an expired or mismatched certificate fails identically on
 * every retry, and is a deployment somebody has to go and fix.
 *
 * {@link isTransient} already drew that line by status number, so the retry
 * behaviour here is unchanged — but a caller reading the TYPE was told the two
 * were the same thing, while the list beside it said they were not. The
 * mandala-computer-python SDK had the same pairing and a worse consequence: its
 * fatal-error set names classes, so a wait helper could not tell 526 from 522
 * and spent its whole timeout retrying a certificate.
 */
export class OriginTLSError extends APIError {
  override name = 'OriginTLSError';
}

const BY_STATUS: Record<number, typeof APIError> = {
  401: AuthenticationError,
  402: PlanLimitError,
  403: PermissionDeniedError,
  404: NotFoundError,
  409: ConflictError,
  503: UnavailableError,
  504: GatewayTimeoutError,
  // NOT OriginUnreachableError, which is the trap in this range: 520 means the
  // platform WAS reached and answered unreadably. See OriginResponseError.
  520: OriginResponseError,
  521: OriginUnreachableError,
  522: OriginUnreachableError,
  523: OriginUnreachableError,
  524: GatewayTimeoutError,
  // Their own class, not more entries on the one above: an unreachable origin is
  // a passing outage and these are a deployment somebody has to fix.
  525: OriginTLSError,
  526: OriginTLSError,
};

/**
 * What a caller is told when a proxy abandoned the request and named nothing.
 *
 * Used only where the response carried no structured message of its own — see
 * {@link platformNamed}. A 524 is generated at the edge, so that is the usual
 * case: it carries a proxy's HTML error page or — when the request asked for
 * JSON, as every request from this server does — nothing at all. The empty
 * case is the dangerous one:
 * it left the model reading the bare string `HTTP 524`, which names no cause, no
 * culprit and no way out, and whose obvious next move is a retry that fails
 * identically.
 *
 * Worded for any route, and the exec sentence hedged, because any of them can
 * end here. A 504 in particular is the retryable half of this pair, so the wait
 * tools reach it while polling and replay it in their give-up text — telling the
 * caller of a `wait_for_computer` to re-run with `background: true` and read the
 * output with `exec_poll` would send them after a parameter that tool does not
 * have. Same for a screenshot or a listing that meets the ceiling.
 */
const GATEWAY_TIMEOUT_MESSAGE =
  'a proxy in front of the platform gave up waiting for it to answer. Nothing was ' +
  'cancelled: the platform never saw this deadline, so anything this request had already ' +
  'set going carries on without it — usually it has the request and is still working, ' +
  'though a 504 can come from a hop that never reached it. Most often that is a ' +
  'foreground exec, which ends ' +
  'this way after about two minutes however large a timeout_s it was given — the ' +
  'ceiling belongs to the proxy, not to the platform, so a larger timeout_s buys no ' +
  'time and background: true with exec_poll is the way to run something slower. After ' +
  'one of those, the next call on that computer may report the guest agent as busy ' +
  'with the command that outlived the request';

/** What a caller is told when the platform's own answer arrived unreadable. */
const ORIGIN_RESPONSE_MESSAGE =
  'the platform received the request and the exchange then broke on the way back — an ' +
  'empty or unreadable response, a connection dropped before the headers, an origin that ' +
  'stopped part-way. Unlike an unreachable origin, the request did arrive, so it may have ' +
  'been carried out in full, in part, or not at all. Retrying a read costs nothing; before ' +
  'retrying anything that creates something — a computer, a snapshot — check whether the ' +
  'first attempt took effect, or you may end up with two of it';

/** What a caller is told when a proxy could not reach the platform at all. */
const ORIGIN_UNREACHABLE_MESSAGE =
  'a proxy in front of the platform could not reach it. Almost always that means the ' +
  'request was never sent, so nothing was started and there is no work on the other side ' +
  'of this to account for — unlike a gateway timeout. Almost, rather than never, because ' +
  'a connection can also time out after it was established, and bytes already on the wire ' +
  'are not unsent because the answer never came back: retry a read freely, and look before ' +
  'retrying something that creates. Usually this is the platform restarting or a short ' +
  'outage, which clears on its own; if it persists the platform is down, and waiting is ' +
  'the only thing that helps';

/** The same, for the two of those that waiting will not fix. */
const ORIGIN_TLS_MESSAGE =
  'a proxy in front of the platform could not complete a TLS handshake with it, so the ' +
  'request was never sent. This is a misconfigured deployment rather than a passing ' +
  'outage — an expired or mismatched certificate fails the same way on every retry, so ' +
  'report it rather than waiting it out';

/**
 * Whether the response named this failure in the shape this surface uses.
 *
 * Only a JSON body with a non-empty `error` string counts. An HTML page and an
 * empty body are an intermediary's, and both are worth discarding for the
 * wording below; a structured message is not. "upstream unavailable before
 * dispatch" is a more specific true thing than anything written here, and
 * replacing it would be this server overwriting a hop that knew more than it
 * does with a guess.
 *
 * Which hop wrote it is not knowable from here, and does not need to be. The
 * test is whether SOMETHING said something specific, not whether it was the
 * platform — a 504 can be raised by any proxy in the chain, including one in
 * front of a MANDALA_BASE_URL this server has never seen.
 */
function platformNamed(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const err = (body as { error?: unknown }).error;
  return typeof err === 'string' && err.length > 0;
}

/** Build the error for a status, with the platform's own message when it sent one. */
export function errorForStatus(status: number, message: string, body?: unknown): APIError {
  const Cls = BY_STATUS[status] ?? APIError;
  // Substituted for an empty body, which says nothing, and for a proxy's HTML
  // page, which says 500 characters of nothing. NOT for a structured message:
  // that is the one case where the response knows more than this file does.
  if (Cls === GatewayTimeoutError && !platformNamed(body)) {
    return new GatewayTimeoutError(GATEWAY_TIMEOUT_MESSAGE, status, body);
  }
  // No such guard here, and the asymmetry is the point. 520-526 are Cloudflare's
  // own, and every one of them means the request never reached the platform —
  // so there is no reading on which a body carries the platform's account of
  // what happened, and nothing to defer to.
  // Guarded, where the unreachable statuses below are not, and the difference is
  // which of them the platform could have spoken through. A 520 is its own
  // answer arriving mangled, so a body that parsed as this surface's JSON
  // plausibly IS its account. On 521-526 it provably cannot be.
  if (Cls === OriginResponseError && !platformNamed(body)) {
    return new OriginResponseError(ORIGIN_RESPONSE_MESSAGE, status, body);
  }
  if (Cls === OriginTLSError) {
    return new OriginTLSError(ORIGIN_TLS_MESSAGE, status, body);
  }
  if (Cls === OriginUnreachableError) {
    return new OriginUnreachableError(ORIGIN_UNREACHABLE_MESSAGE, status, body);
  }
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
  return (
    err instanceof ConflictError ||
    err instanceof UnavailableError ||
    err instanceof ConnectivityError ||
    // 520 stays, and the reason is worth stating because the class next to it
    // says a blind retry is the thing to be careful about. Both are true. A 520
    // is unsafe to replay when the call CHANGED something; this list is read
    // only by the wait tools, which poll `GET /computers/:id` and an `exec
    // 'true'` probe, and replaying either costs nothing. The caution belongs to
    // whoever retries a create — which is what OriginResponseError's message is
    // for — not to a loop that only ever asks questions.
    (err instanceof APIError && [429, 502, 504, 520, 521, 522, 523].includes(err.status))
  );
}
