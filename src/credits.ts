import { z } from 'zod';
import { Api, type ApiOptions } from './api.js';
import * as P from './paths.js';

/**
 * The account's AI credits, and the one decision this server makes from them:
 * whether `run_agent` is offered to a session that has no model key (OPL-5866).
 *
 * Without a model key the platform runs an agent on the account's own Mandala
 * AI credits. It admits such a run only when the account is not frozen and has
 * at least $0.25 available for the first model call, and refuses it otherwise
 * with a 402 before anything runs. A tool a model can see is a tool it will try,
 * so `run_agent` is registered for a key-less session only when `GET /credits`
 * says that first call would be admitted — and not when the read fails, is
 * refused, or answers something this server cannot read. Failing closed costs a
 * session the tool; failing open costs it a tool that refuses every call.
 */

const micros = z.number().int().safe();
const amount = micros.nonnegative();
const instant = z.string().min(1);

/** `GET /credits`, as the platform documents it. Unknown fields are dropped. */
export const creditsSchema = z.object({
  balance_micros: amount,
  available_micros: micros,
  held_micros: amount,
  debt_micros: amount,
  frozen: z.boolean(),
  grant: z
    .object({
      period_start: instant,
      period_end: instant,
      granted_micros: amount,
      used_micros: amount,
    })
    .nullable(),
  lots: z.array(
    z.object({
      id: z.string().min(1),
      kind: z.string().min(1),
      amount_micros: amount,
      remaining_micros: amount,
      expires_at: instant,
      created_at: instant,
    }),
  ),
  entries: z.array(
    z.object({
      id: amount,
      lot_id: z.string().nullable(),
      kind: z.string().min(1),
      amount_micros: amount,
      debt_micros: amount,
      model: z.string().nullable(),
      run_id: z.string().nullable(),
      step: amount.nullable(),
      created_at: instant,
    }),
  ),
  next_before: amount.nullable(),
});
export type Credits = z.infer<typeof creditsSchema>;

/**
 * What a funded run needs available before its first model call: $0.25, in
 * micros. The platform reserves this much per model call and refuses a run it
 * cannot reserve for with a 402; it is also the smallest `max_cost_usd`.
 */
export const FUNDED_RUN_MINIMUM_MICROS = 250_000;

/**
 * How long the check may hold up a session's start. It runs before the
 * session's tools are registered, so a platform that does not answer delays the
 * client's initialize by this much at most, and then the answer is no.
 */
export const CREDITS_CHECK_TIMEOUT_MS = 5_000;

/** Whether a credits record says a funded run would be admitted now. */
export function fundedCredits(credits: Credits): boolean {
  return !credits.frozen && credits.available_micros >= FUNDED_RUN_MINIMUM_MICROS;
}

/**
 * Ask the platform, on this key, whether a run without a model key would be
 * admitted. `false` on any failure: a refusal (a workspace-scoped key is
 * refused this account-wide read), an error, a timeout, or a record that does
 * not parse.
 *
 * Always the caller's own key. The hosted transport calls this per session with
 * the bearer that session arrived with, so one account's credits are never
 * offered to another, and an operator's key is never involved.
 */
export async function fundedAccount(
  apiKey: string,
  baseUrl: string | undefined,
  options: ApiOptions = {},
  timeoutMs = CREDITS_CHECK_TIMEOUT_MS,
): Promise<boolean> {
  try {
    const api = new Api(apiKey, baseUrl, AbortSignal.timeout(timeoutMs), options);
    // One journal entry, the fewest the route allows: only the summary matters.
    const parsed = creditsSchema.safeParse(
      await api.json('GET', P.CREDITS, { query: { limit: 1 } }),
    );
    return parsed.success && fundedCredits(parsed.data);
  } catch {
    return false;
  }
}

/** Micros as dollars, to the cent, for a sentence; the record keeps the exact figure. */
export const dollars = (value: number): string =>
  `${value < 0 ? '-' : ''}$${(Math.abs(value) / 1_000_000).toFixed(2)}`;

/**
 * The top-up page a refusal names, as an absolute URL, or `undefined`.
 *
 * Only a `402` carrying `top_up_url` is "this account's AI credits ran out"; a
 * 402 without one on an agent route is the model provider's billing error for
 * the configured key. The platform sends the page as a path on its own site, so
 * it is resolved against the API's origin. Anything that does not resolve to an
 * http(s) URL is not offered.
 */
export function topUpUrl(status: unknown, body: unknown, baseUrl: string): string | undefined {
  if (status !== 402 || body === null || typeof body !== 'object' || Array.isArray(body))
    return undefined;
  const raw = (body as Record<string, unknown>).top_up_url;
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  try {
    const url = new URL(raw.trim(), baseUrl);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}
