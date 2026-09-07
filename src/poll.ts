/**
 * The machinery every wait loop in this server shares.
 *
 * Its own module rather than lines in computers.ts, because there are now poll
 * loops in two tool files: `wait_for_computer` and `move_computer` watch a
 * computer, and `create_snapshot` watches a capture the platform answers a 202
 * for. A second copy of a two-second interval is not the problem — a second
 * copy of the RULES around it is, and the one that matters is `pollDelay`:
 * a loop that forgot it spends a rate limit discovering it is still rate
 * limited, and nothing about the call site says so.
 */

import { RateLimitError } from './errors.js';

/**
 * A pause that ends early when the caller gives up.
 *
 * The wait loops check the signal at the top of each turn, so a sleep that
 * ignored it would still hold a cancelled call for its remaining seconds.
 */
export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });

/** How long these loops leave between polls. */
export const POLL_MS = 2_000;

/**
 * The same interval, unless the platform asked for longer.
 *
 * A 429 is the one failure that says how long to wait, and
 * {@link isTransientForPoll} now polls through it — so a loop that ignored
 * `Retry-After` and asked again in two seconds would be spending a rate limit
 * to discover it was still rate limited. The floor stays {@link POLL_MS}: the
 * header can say zero, and a poll loop with no interval is a request storm.
 *
 * Only reached from a failed poll, which is why it takes the error rather than
 * living in {@link sleep}: an ordinary turn has nothing to honour.
 */
export const pollDelay = (err: unknown): number =>
  err instanceof RateLimitError && err.retryAfterMs !== undefined
    ? Math.max(POLL_MS, err.retryAfterMs)
    : POLL_MS;

/**
 * How long a wait may go without saying anything.
 *
 * The loops here wake every {@link POLL_MS}, and a notification per turn would
 * be 900 of them across a half-hour capture — the MCP spec asks implementations
 * to rate-limit progress, and a client rendering every frame of "still
 * capturing" is not better informed for it. So a turn that CHANGED something is
 * always reported and an unchanged one is reported at this interval, which is
 * well inside the 60s default that makes any of this necessary.
 */
export const HEARTBEAT_MS = 10_000;

/**
 * What a tool needs from its MCP request in order to be heard while it waits.
 *
 * Structural rather than the SDK's own type: the two members below are all this
 * uses, and naming them here keeps `src/poll.ts` from importing the server's
 * request plumbing to describe a keepalive.
 */
export type ProgressExtra = {
  _meta?: { progressToken?: string | number } | undefined;
  sendNotification: (notification: {
    method: 'notifications/progress';
    params: {
      progressToken: string | number;
      progress: number;
      total?: number;
      message?: string;
    };
  }) => Promise<void>;
};

/** Somewhere to log a line for a person watching, without importing McpServer. */
export type Logger = { sendLoggingMessage: (m: { level: 'info'; data: string }) => Promise<void> };

/**
 * The keepalive a wait longer than a minute owes the client it is keeping.
 *
 * WHY A TOOL THAT WAITS HAS TO SPEAK. `_onprogress` in the SDK's
 * shared/protocol.js resets a pending request's timer; `notifications/message`
 * — what `sendLoggingMessage` emits — never touches it. So a tool that only
 * logs is, to the client's timer, a tool that has hung: the request is
 * cancelled at the 60s default while the platform goes on copying a disk, and
 * the model reads a transport error instead of the sentence the tool was
 * written to give it. Observed, not theorised — a live capture took 107s and
 * was cancelled at 60 (OPL-4579), and `run_agent` had the same defect before
 * OPL-4419, where a twenty-step run was cancelled mid-way while still billing
 * the caller's own Anthropic key.
 *
 * IT IS NOT SUFFICIENT ON ITS OWN and no description may claim it is.
 * protocol.js reads `options?.resetTimeoutOnProgress ?? false`, so the reset
 * happens only for a client that asked for it when it made the call. What this
 * does is make the keepalive AVAILABLE — without it no client could hold the
 * request open at all; with it, one that opts in can. The rest is the client's
 * to set, and every tool using this has a `wait: false` or a second call for a
 * client that cannot.
 *
 * Both channels on the same turns, because they answer different people. The
 * progress notification is for the client's timer; the log line is what someone
 * watching a terminal sees, and is the only channel when no token was sent.
 *
 * Failures are swallowed on purpose: a notification nobody could take delivery
 * of must not end a wait that is otherwise going fine.
 */
export function heartbeat(
  extra: ProgressExtra,
  log: Logger | undefined,
  everyMs: number = HEARTBEAT_MS,
): (line: string) => Promise<void> {
  const progressToken = extra._meta?.progressToken;
  let sent = 0;
  let last = '';
  let at = 0;
  return async (line: string) => {
    const now = Date.now();
    // A changed line is news and goes out at once; an unchanged one is a
    // keepalive and goes out on the interval. `sent === 0` covers the first
    // turn, which is the one that establishes the channel — a client that will
    // not hear anything for ten seconds has already spent a sixth of its
    // default budget.
    if (sent > 0 && line === last && now - at < everyMs) return;
    last = line;
    at = now;
    if (progressToken !== undefined) {
      sent += 1;
      await extra
        .sendNotification({
          method: 'notifications/progress',
          // `progress` is the count of notifications, which the SDK's
          // ProgressSchema asks to increase every time. No `total`: a wait does
          // not know how many turns it will take, and a total of 0 renders as a
          // finished bar.
          params: { progressToken, progress: sent, message: line },
        })
        .catch(() => {});
    }
    await log?.sendLoggingMessage({ level: 'info', data: line }).catch(() => {});
  };
}
