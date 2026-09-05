/**
 * What the platform's status codes mean, as types.
 *
 * The distinctions here are the ones an agent has to act on and cannot infer
 * from prose. A 400 never clears and retrying it burns a turn. A 402 is a plan
 * limit, which no amount of waiting fixes and which the user — not the model —
 * has to resolve. A 409 is the one that is not uniform: most of them are a
 * passing state and worth retrying, and some are a decision about the request
 * that no retry turns into a yes — see {@link ConflictError} and
 * {@link MoveRequiredError}.
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
  /**
   * The platform's own word for what KIND of refusal this is, where it sent
   * one: `contention`, `starting`, `unavailable` or `unsupported` (OPL-3898).
   * `undefined` for most errors, and always will be — the platform is explicit
   * that an absent value means unclassified rather than "none of the four".
   *
   * Read on the base class rather than on the one 409 it was filed for, because
   * the platform keys it on the ERROR and not on the route: the same sentinel is
   * reached from several endpoints, and `unavailable` arrives as a 400 as well
   * as a 409 — whoever loses the race to the running check hears the same fact
   * the caller who arrived a moment earlier heard.
   */
  readonly reason?: string;
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.reason = refusalReason(body);
  }
}

/**
 * The two answers `reason` can carry, as sets rather than as types.
 *
 * Kept as data deliberately. The platform states that a fifth word may be added
 * and that a client must read one it does not recognise as "no answer given" —
 * an allow-list of classes would make the next word a breaking change, and the
 * same word arrives on more than one status, so a subclass of any one of them
 * could not carry it. Both memberships are tested rather than one being inferred
 * from the other, which is what makes an unknown word fall through to the type
 * answer instead of reading as permanent. Mirrors `_REASON_CLEARS` and
 * `_REASON_PERMANENT` in mandala-computer-python's `_exceptions.py`.
 */
const REASON_CLEARS: ReadonlySet<string> = new Set(['contention', 'starting']);
const REASON_PERMANENT: ReadonlySet<string> = new Set(['unavailable', 'unsupported']);

/**
 * What to tell a model about a refusal the platform classified, or `undefined`.
 *
 * The word itself is for a program, and the client here is a language model that
 * cannot switch on a JSON key it never sees: {@link failed} renders an error as
 * one sentence. So the classification travels as the clause it means, and the
 * loop OPL-3898 was filed about — a blanket retry against a computer that is
 * simply stopped — is the one these sentences exist to stop.
 *
 * Deliberately silent about anything else. A word this version does not know is
 * not described at all, because inventing advice for it is the mistake the
 * platform's "absent means unclassified" contract exists to prevent.
 */
export function reasonAdvice(reason: string | undefined): string | undefined {
  switch (reason) {
    case 'contention':
      return 'something was in flight; the same call works once it finishes, so this one is worth sending again';
    case 'starting':
      return 'the guest agent is still inside its boot window, so this is worth sending again in a moment';
    case 'unavailable':
      return 'the computer is not running, and this does NOT clear by waiting — start_computer is the fix, and retrying without it spends a turn every time';
    case 'unsupported':
      return 'this computer cannot do it at all, so do not retry it — the answer is the same forever';
    default:
      return undefined;
  }
}

/**
 * The platform's one-word classification off a refusal body, or `undefined`.
 *
 * Shape-checked in the manner of {@link moveOffer} and for its reason: this
 * decides a retry policy, so a body with a `reason` that is not a string has to
 * read as "no answer given" and fall back to what this server did before the key
 * existed. Any string is kept, including one this version has never heard of —
 * the callers compare against the sets above, because the sets are the contract
 * and the raw word belongs to whoever is embedding this.
 */
function refusalReason(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const reason = (body as { reason?: unknown }).reason;
  return typeof reason === 'string' ? reason : undefined;
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
 * yet. Worth retrying; the others on this list are not.
 *
 * USUALLY, and the exception is why {@link MoveRequiredError} exists. Whether a
 * 409 clears is a property of the BODY and not of the status: some describe a
 * passing state, and some describe a decision about the request — the size does
 * not fit, the computer is the wrong one for this, the saved session cannot
 * travel — which no amount of retrying turns into a yes. This class said
 * "worth retrying" flatly, {@link isTransient} agreed with it, and that
 * predicate is exported, so a host application wrapping a resize in
 * `if (isTransient(err)) retry()` looped on a refusal that was never going to
 * move (OPL-3775).
 *
 * Only the refusal that could be acted on has been given a class of its own so
 * far, because a type is worth adding where a caller can DO something different
 * with it. The rest stay here and are told apart by {@link APIError.reason},
 * which is the word the platform added for that purpose (OPL-3898) and the one
 * its own reference now says to switch on — never the sentence, which is prose
 * written for a person and rewritten whenever a better one is. Where no word was
 * sent this class means what it always did, and that fallback is the contract
 * rather than a gap: not every refusal here has an answer yet.
 */
export class ConflictError extends APIError {
  override name = 'ConflictError';
}

/**
 * The 409 that is an OFFER rather than a refusal: a resize needs the computer
 * moved to another host first.
 *
 * `PATCH /computers/{id}` growing `ram_mb` past what the computer's current host
 * can run answers 409 with a `move` object on the body rather than only a
 * sentence — `{"required":true,"possible":true}` means somewhere else in the
 * region could run that size, and `POST /computers/{id}/move` is how a caller
 * agrees to go there. `possible:false` means nowhere in the region can, and the
 * size is the thing to change.
 *
 * Its own class for the reason {@link RangeNotSatisfiableError} has one: it is a
 * refusal the caller can correct without knowing anything it did not just learn,
 * and the correction is a different call rather than a smaller number. Reaching
 * it through a bare `ConflictError` left the flag on `body` where nothing looked
 * for it, and left the retry predicate saying yes.
 *
 * {@link movePossible} is the branch, and it is deliberately read off the body
 * here rather than left to every caller: `move.required` is true in both cases
 * and it is the second field that decides what to do.
 */
export class MoveRequiredError extends ConflictError {
  override name = 'MoveRequiredError';
  constructor(
    message: string,
    status: number,
    body: unknown,
    /** Whether a host in this region could run the size that was asked for. */
    readonly movePossible: boolean,
  ) {
    super(message, status, body);
  }
}

/**
 * The `move` object the platform puts on the refusal above, if this body has one.
 *
 * Shape-checked rather than trusted: this decides a retry policy and a tool's
 * next step, so a body with a `move` key that is a string, or an object with no
 * `possible`, must read as "not that refusal" rather than as a move that is
 * impossible. Absent and malformed are the same answer here, and it is the
 * conservative one — an ordinary ConflictError, which is what this was before.
 */
function moveOffer(body: unknown): { possible: boolean } | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const move = (body as { move?: unknown }).move;
  if (!move || typeof move !== 'object') return undefined;
  const { required, possible } = move as { required?: unknown; possible?: unknown };
  if (required !== true || typeof possible !== 'boolean') return undefined;
  return { possible };
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

/**
 * 429 — the request is valid; the caller has spent a temporary rate budget.
 *
 * A class rather than a number in a list, and that is the OPL-3724 change in
 * one line: {@link isTransient} used to reach 429 by matching `err.status`,
 * which meant this client answered "is it worth retrying" by a mechanism the
 * other two did not share. It is a moment rather than a property of the
 * request, exactly like a 409, and it belongs in the same shape.
 *
 * {@link retryAfterMs} is set when the response carried a usable `Retry-After`.
 * The poll loops honour it, because retrying at their own faster cadence is
 * how a rate limit becomes a longer one.
 */
export class RateLimitError extends APIError {
  override name = 'RateLimitError';
  constructor(
    message: string,
    status: number,
    body?: unknown,
    /** From `Retry-After`, in milliseconds from now, when the response sent one. */
    readonly retryAfterMs?: number,
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

/**
 * The request never left. Nothing was dispatched, so anything may be replayed.
 *
 * NARROWER than it used to be, and the narrowing is the point. This class once
 * wrapped every rejection the transport produced, which meant it also carried
 * the failures that happen AFTER the request reached the platform — a socket
 * reset while the response body was being read, a protocol error on the way
 * back. Those wear the opposite outcome: the platform may well have acted, and
 * the answer is what was lost. They now get {@link ConnectivityInterruptedError},
 * which is a subclass, so `catch (e) { if (e instanceof ConnectivityError) }`
 * still sees both.
 *
 * What is left here is what the name always claimed: DNS that did not resolve,
 * a socket that was refused, a connect that timed out, a TLS handshake that
 * failed. Not one byte of the request was written, so {@link isTransient} can
 * say yes to it even for a caller replaying a create.
 *
 * `Api` raises this one only for a cause it can positively identify as
 * connect-phase; see `neverDispatched` in `src/api.ts`. Everything it cannot
 * identify is the subclass, because the cost of the two wrong answers is not
 * symmetric — see there.
 */
export class ConnectivityError extends MandalaError {
  override name = 'ConnectivityError';
}

/**
 * The request was dispatched and the answer was lost. Outcome unknown.
 *
 * A socket that resets while the response body is being read, an HTTP parser
 * error on the way back, an undici body or headers timeout, a connection
 * failure this client cannot place in either phase. The shared property is the
 * one that matters: the platform may have received the request and acted on it,
 * and nothing in the error says whether it did.
 *
 * So this is FATAL to {@link isTransient} and transparent to
 * {@link isTransientForPoll}, and the split is the same one OPL-3724 made for
 * 502 and 504. Its words apply here unchanged — "a status that is not safe for
 * the riskiest caller of an exported predicate does not belong in it" — and
 * this case had escaped them only because it wears a class whose name says the
 * request never left. `computers.create()` reaches the platform, the platform
 * builds the computer, the socket dies mid-response: an embedder asking
 * {@link isTransient} used to be told yes, replayed the create, and paid for
 * two computers.
 *
 * A SUBCLASS rather than a sibling, which is what keeps this from breaking
 * anyone. `instanceof ConnectivityError` still matches, so existing catch
 * blocks and {@link isTransientForPoll}'s floor need no change; only the one
 * predicate that promises blind replay had to learn the difference. It is the
 * same shape {@link MoveRequiredError} has under {@link ConflictError}, for the
 * same reason: a case that is genuinely a kind of its parent and genuinely
 * answers one question the other way.
 *
 * The poll predicate still rides it out, and that is not an oversight. The wait
 * tools replay reads — a `GET /computers/:id`, an `exec 'exit 0'` probe — and a
 * read whose outcome was lost can simply be read again. Only a caller who might
 * be replaying a WRITE needs the distinction, which is exactly the caller
 * {@link isTransient} is exported for.
 */
export class ConnectivityInterruptedError extends ConnectivityError {
  override name = 'ConnectivityInterruptedError';
}

/**
 * 504, 524 — a proxy in front of the platform gave up before the platform answered.
 *
 * Not a refusal. The request arrived, is very likely still running, and nothing
 * was cancelled; what ended was one hop's willingness to hold a connection open
 * with no response crossing it.
 *
 * One class, two retry answers, and {@link isTransientForPoll} keeps them apart
 * by status rather than by type on purpose — the ONE place a status number
 * still decides anything, because a type cannot separate two statuses that
 * share it. A 504 is worth polling again and a 524 is not, because of where
 * each is reachable from: the wait tools are the only thing here that retries,
 * they poll with short requests, and a 504 on one of those is infrastructure
 * noise that clears. A 524 is only ever reached by holding a request open past
 * the ceiling below — so retrying it unchanged reproduces it exactly, at the
 * same place, because the hop that gave up never saw how long the caller asked
 * to wait.
 *
 * Neither is in {@link isTransient}. That predicate is what an embedder may
 * wrap a create in, and a gateway timeout is the case where the platform has
 * most likely acted already (OPL-3724).
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
 * A 3xx, which this client answers rather than follows.
 *
 * Following one is the tempting default and it is wrong twice over. The bearer
 * is the smaller half: `fetch` strips `Authorization` across origins but keeps
 * it on a same-origin hop, so a redirect inside the configured origin carries
 * the key to a path the operator did not name. The larger half is that a
 * redirect is a CONFIGURATION fact — a `MANDALA_BASE_URL` missing its trailing
 * path, an http URL for an https deployment, a tenant that has moved — and
 * following it silently means the operator never learns the value they set is
 * not the value in use, while every request pays an extra round trip forever.
 *
 * So it is surfaced, and it names the `Location`: the whole point is that the
 * next thing the operator does is put that in `MANDALA_BASE_URL`. It is an
 * `APIError` with the real status so {@link isTransientForPoll}'s `>= 500` rule
 * files it with the 4xx, where it belongs — repeating the request unchanged
 * cannot change the answer.
 */
export class RedirectError extends APIError {
  override name = 'RedirectError';
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
 * The line was already drawn by status number, so the retry behaviour here was
 * unchanged when this class appeared — but a caller reading the TYPE was told
 * the two were the same thing, while the list beside it said they were not.
 *
 * The type is now what draws it: {@link isTransientForPoll} names this class in
 * its fatal set, and 521-523 fall through to the poll (OPL-3724). Which is also
 * why splitting it mattered more than it looked — the mandala-computer-python
 * SDK had the same pairing and named classes in its fatal set, so a wait helper
 * there could not tell 526 from 522 and spent its whole timeout retrying a
 * certificate.
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
  // Reached through errorForStatus only when the response headers were not in
  // hand — Api.#error builds this one itself, for RangeNotSatisfiableError's
  // reason: `Retry-After` is on the headers and the number is worth keeping.
  // The entry is here so a 429 arriving from anywhere else is still the right
  // class, which is what {@link isTransient} now asks about.
  429: RateLimitError,
  // The other status a proxy writes on its own, and it was the one gap left in
  // this range: with no entry it fell through to a bare APIError, so a model
  // read `HTTP 502` or 500 characters of nginx's HTML — the exact failure the
  // statuses below exist to remove. It polls through isTransientForPoll — the
  // outcome of a 502 is unknown, and a read whose outcome is unknown can simply
  // be read again — so the wait tools reach it and replay whichever of those two
  // it was into their give-up text. Filed with 520 because the honest answer is the same one:
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
 * any hop that gave up early, at no fixed deadline, and
 * {@link isTransientForPoll} says it is worth retrying unchanged; telling its
 * caller that retrying buys no time contradicts that and is false besides. Hedging on "if this was an exec" does
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
  return platformSaid(body) !== undefined;
}

/**
 * The sentence a response carried in its own words, or `undefined` for one that
 * carried none — the same test {@link platformNamed} asks, with the answer kept.
 *
 * Exported for the one caller that has to print a message the substitutions
 * above would otherwise have written for it. A tool whose route contradicts the
 * generic wording for a status — `window_action` and a 504, where
 * {@link GatewayTimeoutError}'s tail says the same call again is the move and on
 * that route it is not — cannot append its own paragraph under prose that says
 * the opposite. It needs to know whether the sentence in `message` came from a
 * hop that knew this request, in which case it is worth repeating, or from this
 * file, in which case it is worth replacing (OPL-3910).
 *
 * Reads the BODY rather than the message, deliberately. By the time an error
 * exists the two may differ — that is what the substitutions are — so asking the
 * message whether it is the platform's would be asking the answer to vouch for
 * itself.
 */
export function platformSaid(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const err = (body as { error?: unknown }).error;
  return typeof err === 'string' && err.length > 0 ? err : undefined;
}

/** Build the error for a status, with the platform's own message when it sent one. */
export function errorForStatus(status: number, message: string, body?: unknown): APIError {
  const Cls = BY_STATUS[status] ?? APIError;
  // The 409 that is an offer, told apart by its body. Before the substitutions
  // below because it never wants one: the platform's sentence here is the whole
  // explanation of what will not fit and what moving would cost, written to be
  // read by whoever has to agree to it.
  if (Cls === ConflictError) {
    const offer = moveOffer(body);
    if (offer) return new MoveRequiredError(message, status, body, offer.possible);
  }
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
 * The PUBLIC answer, exported from the package, and therefore a contract with
 * embedders rather than a private note to this file. Its caller is a host
 * application wrapping an arbitrary call in `if (isTransient(err)) retry()` —
 * including one that creates something — so it names only failures that both
 * clear on their own AND are safe to replay blind.
 *
 * Answered by TYPE, with no status numbers at all, which is the OPL-3724
 * decision written down. Three clients had drifted into three mechanisms for
 * one question: this file matched classes plus a list of numbers, the
 * TypeScript SDK matched classes alone, and the Python SDK named the fatal
 * exceptions and retried the rest. The status list is what let this one drift,
 * because a number can be added to it without anyone having to say which of the
 * three answers changed. It now reads identically in all three:
 *
 * - {@link ConflictError} — something is in flight that this cannot run
 *   alongside, minus the one that is a decision
 * - {@link RateLimitError} — a cadence, and the response usually says how long
 * - {@link UnavailableError} — a hypervisor briefly out of reach
 * - {@link ConnectivityError} — the request never left
 *
 * That last line is now literally true, and it was not always. The class used
 * to cover every transport rejection, a lost response body included, so this
 * predicate told a caller replaying a create that the platform had not been
 * reached when in fact it had been and the answer was what went missing.
 * {@link ConnectivityInterruptedError} carries that case now and is excluded
 * below — the same decision as the paragraph after this one, applied to the
 * one class it had missed (OPL-3855).
 *
 * 502 and 504 USED to be here and are deliberately gone. The paragraph below
 * had already conceded the point that removes them: both can arrive after the
 * platform has acted, so replaying a `create_computer` through one can leave a
 * second billable computer behind a failure that read as nothing having
 * happened. A status that is not safe for the riskiest caller of an exported
 * predicate does not belong in it. Nothing waits less as a result — the wait
 * tools ask {@link isTransientForPoll}, which still rides both out.
 *
 * "Worth trying again" is not "the call definitely did not happen", and no
 * predicate taking only an error can tell you the second. Even here, a 409 can
 * be answered after a change landed. So retry reads freely, and check before
 * repeating anything that creates something.
 *
 * Nor is a status enough on its own to answer it. 409 is the case: most of them
 * are a passing state, and the move offer is a decision that no retry changes,
 * which is why the check below leads with the type rather than the number. If a
 * second such refusal earns a class, it belongs on that line too.
 *
 * One 409 could not be given a class and could not be seen from here at all: a
 * clipboard read or write against a computer that is STOPPED does not clear on
 * its own — a start is the fix, not another attempt — and nothing in the body
 * told it apart from a conflict that is merely passing. The advice was to read
 * the message, which is prose the platform is free to reword and exactly the
 * matching OPL-3724 got three clients out of. The platform now says which kind
 * it is, so {@link APIError.reason} is consulted BEFORE the types below, and an
 * absent word — or one this version does not know — leaves the type answer
 * standing unchanged (OPL-3898).
 *
 * One refusal is known to sit on the wrong side of that fallback, and it stays
 * there deliberately (OPL-3909). A computer runs at most sixteen background
 * commands, and the request for a seventeenth is refused 409 with no `reason` —
 * correctly, since the slots may be held by servers and the platform will not
 * advise a retry it cannot promise. The type answer therefore stands, and it
 * says yes to something that may never clear. The alternative is to read the
 * platform's sentence, which is the exported-contract version of the mistake
 * OPL-3724 removed from three clients: a predicate that changes its answer when
 * somebody rewords a message. So the next step is given where the sentence can
 * be read safely — in `exec`, which knows it asked for a slot and which prints
 * the platform's own words either way — and this predicate is left honest about
 * what it can and cannot tell apart.
 */
export function isTransient(err: unknown): boolean {
  // A move offer is a 409 and is NOT transient — it is a decision about the
  // size that was asked for, and the same request answers the same way forever.
  // First, because it is a subclass of the very branch below that would say yes
  // (OPL-3775). An embedder wrapping a resize in `if (isTransient(err)) retry()`
  // is the caller this line is for.
  if (err instanceof MoveRequiredError) return false;
  // A lost RESPONSE is not a request that never left, and only one of the two
  // is safe to replay blind. Same shape as the line above and the same reason:
  // a subclass of a branch below that would otherwise say yes (OPL-3855).
  if (err instanceof ConnectivityInterruptedError) return false;
  // The platform's own word, ahead of the types below, because it is the more
  // specific answer and it is the one that tells the 409 that never clears from
  // the two that do (OPL-3898). Only an APIError carries a shape-checked one:
  // an arbitrary exception may happen to have a `reason` property, and that is
  // neither this protocol nor retry advice.
  if (err instanceof APIError && err.reason !== undefined) {
    if (REASON_CLEARS.has(err.reason)) return true;
    if (REASON_PERMANENT.has(err.reason)) return false;
  }
  return (
    err instanceof ConflictError ||
    err instanceof RateLimitError ||
    err instanceof UnavailableError ||
    err instanceof ConnectivityError
  );
}

/**
 * The same words, a different question: worth POLLING again.
 *
 * Asked only by the wait tools, and deliberately not exported. They replay a
 * `GET /computers/:id`, a `GET /moves`, a build read or an `exec 'exit 0'`
 * probe — every one of them idempotent, every one of them under a deadline the
 * caller set. That pair of properties is what makes this predicate generous,
 * and it is a property of what those calls DO rather than of the error, which
 * is exactly why it cannot be published: the same `true` handed to an embedder
 * retrying a create means something else entirely.
 *
 * DENY-LIST, and the inversion is the second half of the OPL-3724 decision.
 * Where {@link isTransient} names what may be retried, this names what may not
 * and polls through everything else. The polarity follows from who pays for a
 * wrong answer. Retrying something unretryable costs one poll interval and,
 * at worst, the deadline the caller chose. NOT retrying something that would
 * have cleared costs a wait that reports a machine as unreachable while it was
 * coming up — and every status the edge invents next year lands in that second
 * category under an allow-list, silently, until somebody notices and adds a
 * number. This way round, an unmapped 5xx is ridden out, which is what a poll
 * loop was for.
 *
 * The line is REQUEST versus MOMENT. A failure describing the request answers
 * the same way forever and is fatal here; a failure describing the moment is
 * what a poll exists to outlast.
 *
 * Fatal, therefore:
 *
 * - anything that is not a failed REQUEST. That is the floor, and a deny-list
 *   needs one: only {@link APIError} and {@link ConnectivityError} describe an
 *   exchange with the platform that did not work, and only those can be worth
 *   making again. A `TypeError` from a bug in this file is not the platform
 *   being slow, and riding one out spends the caller's deadline before
 *   reporting the wrong cause.
 *
 *   A bare {@link MandalaError} is caught by the same floor, and that is the
 *   half worth spelling out. `Api` raises them for a response that arrived and
 *   made no sense — "expected JSON from GET /computers/:id, got: <html>" — and
 *   a poll loop raises them as verdicts about a poll that SUCCEEDED. Neither is
 *   a moment to outlast: one is a defect and the other is an answer. Polling
 *   through a verdict is an infinite loop with a deadline on it, which is
 *   exactly what the TypeScript SDK's suite caught when this predicate was
 *   ported there with `MandalaError` as its floor.
 *
 *   {@link ConnectivityInterruptedError} passes that floor and is meant to, on
 *   the strength of what the callers here DO. It says the outcome of one
 *   request is unknown; every request this predicate guards is a read, and a
 *   read whose outcome is unknown can be read again. Fatal to
 *   {@link isTransient} and transparent here is the whole point of there being
 *   two predicates.
 * - {@link CancelledError} — the caller hung up. Excluded by the floor above,
 *   since it is neither, and retrying something nobody is waiting for is what
 *   `with(signal)` exists to stop.
 * - {@link MoveRequiredError} — a decision about the size that was asked for.
 * - {@link OriginTLSError} (525, 526) — a certificate the edge and the platform
 *   cannot agree on fails identically on every retry, so waiting one out spends
 *   the whole deadline to report the wrong cause. Its own message says to go and
 *   fix the deployment; this is what makes that true.
 * - 524 — reached only by holding a request open past the edge's ceiling, so an
 *   identical retry reproduces it at the same place. It shares
 *   {@link GatewayTimeoutError} with 504, which is retryable, and that is why
 *   this one status is still matched by NUMBER: the type cannot separate them.
 * - anything below 500 that is not named. A 4xx describes the request — a bad
 *   body, a revoked key, a plan limit, a deleted id, an offset past the end of a
 *   file — and repeating it unchanged cannot change the answer. Three are named
 *   because they describe the moment instead: 409 (something in flight), 429 (a
 *   cadence), and 408, which RFC 9110 defines as a request the client may repeat
 *   unchanged and which the edge in front of this surface does emit.
 *
 *   A 3xx goes with the 4xx, which is why the test is `>= 500` rather than "not
 *   a 4xx". `Api` treats every non-2xx as an error and does not follow
 *   redirects, so a MANDALA_BASE_URL missing its trailing path answers 301 — and
 *   under a 4xx-only rule that was polled until the deadline, ending in a
 *   give-up that named nothing about the redirect. The mandala-computer-python
 *   SDK found that one; this is the same rule, and it is why all three now say
 *   `>= 500`.
 *
 *   "Does not follow redirects" is a claim about `#fetch`'s `redirect: 'manual'`
 *   and is load-bearing HERE, in a way it was not while the default `'follow'`
 *   silently made it untrue: under `'follow'` a 3xx never reaches this predicate
 *   at all, so the paragraph above described a case that could not arise and the
 *   `>= 500` bound rested on nothing. {@link RedirectError} is what a 3xx
 *   becomes now. Change one and this paragraph is wrong again.
 *
 * {@link APIError.reason} is deliberately NOT consulted here, and that is the
 * one place this predicate and {@link isTransient} part company (OPL-3898).
 * `unavailable` means the computer is not running, which is a permanent answer
 * to whoever asked — and a poll under a deadline is the one caller for whom it
 * may not be, since a computer coming up passes through it. The same generosity
 * as every unmapped 5xx below, for the same reason: this only ever replays a
 * read, and the loops above return a refusal of their own the moment the status
 * they are watching says stopped or suspended. mandala-computer-python's
 * `_is_transient_for_poll` draws the line in the same place.
 *
 * Everything at 5xx polls through, 502 and 520-523 included: they mean the
 * outcome is unknown, and a read whose outcome is unknown can simply be read
 * again.
 *
 * 5xx has an upper bound as well as a lower one, and it is not decoration. The
 * HTTP parser under `fetch` accepts any three digits, so a broken or hostile
 * origin can answer 700 — which `>= 500` alone called a passing moment and
 * polled until the caller's deadline (Codex adversarial review, OPL-3724).
 */
export function isTransientForPoll(err: unknown): boolean {
  if (!(err instanceof APIError) && !(err instanceof ConnectivityError)) return false;
  if (err instanceof MoveRequiredError) return false;
  if (err instanceof OriginTLSError) return false;
  if (err instanceof APIError) {
    if (err.status === 524) return false;
    if (err.status === 408 || err.status === 409 || err.status === 429) return true;
    return err.status >= 500 && err.status < 600;
  }
  return true;
}
