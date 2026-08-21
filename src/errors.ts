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

/**
 * 416 — the `Range` named no byte the file has.
 *
 * Its own class because it is the one refusal on the download route that a
 * caller can correct without knowing anything it did not just learn: the
 * response carries `Content-Range: bytes *\/<size>`, so the file's real length
 * arrives with the complaint about the offset. {@link size} is that number,
 * kept off the message so a tool can put the offset it sent beside it.
 *
 * A model paging a file it has not measured is the caller that meets this, and
 * an offset past the end is the mistake it will actually make.
 */
export class RangeNotSatisfiableError extends APIError {
  override name = 'RangeNotSatisfiableError';
  constructor(
    message: string,
    status: number,
    body?: unknown,
    /** The file's real length, off `Content-Range`, when the response sent one. */
    readonly size?: number,
  ) {
    super(message, status, body);
  }
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
 * 521-523 — a proxy in front of the platform could not reach it.
 *
 * The range this once claimed — 520-523, 525, 526 — is the range before the two
 * statuses that needed their own answers were split out of it: 520 to
 * {@link OriginResponseError}, because the platform WAS reached, and 525-526 to
 * {@link OriginTLSError}, because waiting does not fix a certificate.
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
 * 502, 520 — a proxy had no usable answer from the platform.
 *
 * Sits between the other two and must not be filed with either, because the
 * question a caller is really asking is whether their work happened, and these
 * are the statuses whose honest answer is "unknown".
 *
 * One class, two messages, because the two do not know the same amount. A 520 is
 * Cloudflare naming its origin's reply unreadable, so arrival is established. A
 * 502 is any proxy saying it has nothing it can use, which covers both an
 * invalid reply and no reply at all — indistinguishable from here, so it claims
 * neither. See BAD_GATEWAY_MESSAGE.
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
  // Only ever reached through errorForStatus, which cannot see the response
  // headers and so cannot fill in `size`. Api.#error builds this one itself for
  // that reason; the entry is here so the mapping stays complete, and so a 416
  // arriving from anywhere else is still the right class with the platform's
  // own message on it.
  416: RangeNotSatisfiableError,
  // The other status a proxy writes on its own, and it was the one gap left in
  // this range: with no entry it fell through to a bare APIError, so a model
  // read `HTTP 502` or 500 characters of nginx's HTML — the exact failure the
  // statuses below exist to remove. It is also in isTransient, which means the
  // wait tools reach it and replay whichever of those two it was into their
  // give-up text. Filed with 520 because the honest answer is the same one:
  // unknown. See BAD_GATEWAY_MESSAGE for why it is not filed with 521-523.
  502: OriginResponseError,
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
 * Two statuses share this class and must NOT share all of this wording, which is
 * why the text is built per status rather than written once. The ceiling — about
 * two minutes, a larger `timeout_s` buying no time, `background: true` as the
 * shape that survives it — is a fact about a 524 specifically. A 504 comes from
 * any hop that gave up early, at no fixed deadline, and {@link isTransient} says
 * it is worth retrying unchanged; telling its caller that retrying buys no time
 * contradicts that and is false besides. Hedging on "if this was an exec" does
 * not fix it, because the wrong half is the status, not the route.
 */
const GATEWAY_TIMEOUT_SHARED =
  'a proxy in front of the platform gave up waiting for it to answer. Nothing was ' +
  'cancelled: the platform never saw this deadline, so anything this request had already ' +
  'set going carries on without it';

/**
 * The 524 tail: the ceiling, and what it means for the route that meets it most.
 *
 * Still hedged on the route, because a screenshot or a listing can meet the same
 * ceiling and neither takes a `timeout_s` — the wait tools do not reach a 524 at
 * all, which is the other half of why this is safe to say here and was not safe
 * to say for a 504.
 */
const GATEWAY_TIMEOUT_CEILING =
  ' — usually it has the request and is still working. Most often that is a foreground ' +
  'exec, and if this one was, it ended this way after about two minutes however large a ' +
  'timeout_s it was given: the ceiling belongs to the proxy, not to the platform, so on ' +
  'that route a larger timeout_s buys no time, background: true with exec_poll is what ' +
  'runs something slower, and the next call on that computer may report the guest agent ' +
  'as busy with the command that outlived the request';

/**
 * The 504 tail: no ceiling, no route-specific advice, and retrying is the move.
 *
 * A 504 can be raised by any hop, including one that never reached the platform,
 * so it cannot promise the work is running the way a 524 can.
 */
const GATEWAY_TIMEOUT_TRANSIENT =
  ', though a 504 can also come from a hop that never reached it, so whether the work is ' +
  'running is not knowable from here. No fixed deadline was hit and nothing about the ' +
  'request needs changing: this usually clears, and the same call again is the move — ' +
  'check before repeating anything that creates something, since the first attempt may ' +
  'yet have landed';

/** The message for a gateway timeout, with only the half its status can support. */
function gatewayTimeoutMessage(status: number): string {
  return (
    GATEWAY_TIMEOUT_SHARED + (status === 524 ? GATEWAY_TIMEOUT_CEILING : GATEWAY_TIMEOUT_TRANSIENT)
  );
}

/** What a caller is told when the platform's own answer arrived unreadable. */
const ORIGIN_RESPONSE_MESSAGE =
  'the platform received the request and the exchange then broke on the way back — an ' +
  'empty or unreadable response, a connection dropped before the headers, an origin that ' +
  'stopped part-way. Unlike an unreachable origin, the request did arrive, so it may have ' +
  'been carried out in full, in part, or not at all. Retrying a read costs nothing; before ' +
  'retrying anything that creates something — a computer, a snapshot — check whether the ' +
  'first attempt took effect, or you may end up with two of it';

/**
 * What a caller is told for a 502, which is the two failures either side of it.
 *
 * Not ORIGIN_RESPONSE_MESSAGE, though it shares that class. A 520 is Cloudflare
 * saying the origin answered unreadably, so "the request did arrive" is known.
 * A 502 is any proxy saying it has no usable answer, and the two reasons —
 * upstream replied with something invalid, upstream could not be reached — are
 * indistinguishable from the outside. Asserting arrival would be the same shape
 * of confident falsehood as the "nothing was started" this branch removed from
 * 520, pointed the other way, so this says the one true thing instead.
 */
const BAD_GATEWAY_MESSAGE =
  'a proxy in front of the platform had no usable answer from it — either the platform ' +
  'replied with something the proxy could not read, or it could not be reached at all, ' +
  'and which of those happened is not visible from here. So whether the request arrived ' +
  'is unknown, and with it whether the work was done: retrying a read costs nothing, but ' +
  'before retrying anything that creates something — a computer, a snapshot — check ' +
  'whether the first attempt took effect. Usually this is a passing outage that clears';

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
  //
  // The same guard on every branch below, because platformNamed already settles
  // the question they were once split over. Two of these used to substitute
  // unconditionally, on the reading that a 521-526 cannot carry the platform's
  // account of itself — true, and beside the point. platformNamed does not ask
  // whether the PLATFORM spoke; it asks whether anything did, precisely because
  // a hop in front of a self-hosted MANDALA_BASE_URL is a hop this server has
  // never seen and cannot outrank. An operator's own gateway answering 522 with
  // `{"error":"backend pool empty; scale the worker group"}` knows more about
  // that deployment than the generic outage prose here does, and discarding it
  // was the very thing the 504 and 520 guards exist to prevent.
  if (Cls === GatewayTimeoutError && !platformNamed(body)) {
    return new GatewayTimeoutError(gatewayTimeoutMessage(status), status, body);
  }
  if (Cls === OriginResponseError && !platformNamed(body)) {
    // 502 and 520 share a class and not a message: one knows the request
    // arrived, the other cannot tell. See BAD_GATEWAY_MESSAGE.
    const said = status === 502 ? BAD_GATEWAY_MESSAGE : ORIGIN_RESPONSE_MESSAGE;
    return new OriginResponseError(said, status, body);
  }
  if (Cls === OriginTLSError && !platformNamed(body)) {
    return new OriginTLSError(ORIGIN_TLS_MESSAGE, status, body);
  }
  if (Cls === OriginUnreachableError && !platformNamed(body)) {
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
 *
 * Exported, and therefore a contract with embedders rather than a private note
 * to this file — which is the whole reason it is narrower than
 * {@link isTransientForPoll}. A host application wrapping `create_computer` in
 * `if (isTransient(err)) retry()` is the caller this list has to be safe for,
 * and the 52x statuses are not safe for it: 520-523 mean the outcome is unknown,
 * so replaying a create can leave two billable computers behind a failure that
 * looked like nothing happened.
 *
 * "Worth trying again" is not "the call definitely did not happen", and no
 * predicate taking only an error can tell you the second. Even here, a 502 or a
 * 504 can arrive after the platform has already acted — so retry reads freely,
 * and check before repeating anything that creates something.
 */
export function isTransient(err: unknown): boolean {
  return (
    err instanceof ConflictError ||
    err instanceof UnavailableError ||
    err instanceof ConnectivityError ||
    (err instanceof APIError && [429, 502, 504].includes(err.status))
  );
}

/**
 * The same question, asked by a loop that only ever reads.
 *
 * Deliberately not exported from the package. The wait tools poll
 * `GET /computers/:id` and an `exec 'true'` probe, and replaying either costs
 * nothing, so they can ride out the statuses whose outcome is unknown — a 52x
 * during a boot wait is an outage to sit through, not a reason to fail a caller
 * who asked to wait. That reasoning is a property of what those two calls DO,
 * not of the error, which is exactly why it cannot be published as one: the same
 * `true` handed to an embedder retrying a create means something else entirely.
 *
 * 525 and 526 stay out. A TLS handshake that fails once fails identically on
 * every retry, so waiting on one only spends the caller's deadline.
 */
export function isTransientForPoll(err: unknown): boolean {
  return isTransient(err) || (err instanceof APIError && [520, 521, 522, 523].includes(err.status));
}
