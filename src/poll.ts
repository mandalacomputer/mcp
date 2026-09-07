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
