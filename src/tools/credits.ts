import { z } from 'zod';
import { creditsSchema, dollars } from '../credits.js';
import { said } from '../format.js';
import * as P from '../paths.js';
import { metadata, metadataCall } from './directory.js';
import { readAnnotations } from './results.js';
import type { Registrar } from './types.js';

/** The platform's page size bounds for the credit journal. */
const PAGE_MAX = 100;

/**
 * The account's AI credits (OPL-5866): what pays for run_agent when no model
 * key is configured. A passive read, registered for every session — a key
 * that cannot read the ledger is told so by the platform, which is a better
 * answer than a tool that is not there.
 */
export const registerCredits: Registrar = (server, session) => {
  server.registerTool(
    'get_credits',
    {
      title: 'Read AI credits',
      description:
        "This account's Mandala credits, which pay for run_agent when no model key is configured and, on pay as you go, for its computers: how the account is billed (subscription, trial, pay as you go or none), and on pay as you go what its computers cost an hour now and how long the balance lasts at that rate (zero once it has run out, when running computers are suspended and nothing new starts); available (balance minus debt and credits held for runs in progress; can be negative, and zero while frozen), balance, held, debt, frozen (no plan or a suspended account: credits are kept and still expire, but cannot be spent), this billing period's plan grant, the unexpired lots, and the journal, newest first. Amounts are integer USD micros (1,000,000 = $1). A key confined to a workspace is refused (403): the ledger is the whole account's.",
      inputSchema: z.strictObject({
        before: z
          .number()
          .int()
          .min(1)
          .max(Number.MAX_SAFE_INTEGER)
          .optional()
          .describe('Older journal entries: the next_before of the page before.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(PAGE_MAX)
          .optional()
          .describe(`Journal entries per page, 1 to ${PAGE_MAX}; the platform defaults to 50.`),
      }),
      annotations: readAnnotations,
    },
    ({ before, limit }, extra) =>
      metadataCall(async () => {
        const data = metadata(
          creditsSchema,
          await session.api.json('GET', P.CREDITS, {
            query: { before, limit },
            signal: extra.signal,
          }),
        );
        return said(
          `${dollars(data.available_micros)} available` +
            (data.frozen
              ? ' — FROZEN: no plan, or the account is suspended, so none of it can be spent'
              : '') +
            ` (balance ${dollars(data.balance_micros)}, held ${dollars(data.held_micros)}, debt ${dollars(data.debt_micros)}).` +
            (data.billing_mode === 'payg'
              ? ` ${paygLine(data.burn_micros_per_hour, data.runway_seconds)}`
              : '') +
            (data.next_before !== null
              ? ` Older journal entries: before=${data.next_before}.`
              : ''),
          data,
        );
      }),
  );
};

/** What pay as you go is costing, for the summary line. */
function paygLine(burn: number | null | undefined, runway: number | null | undefined): string {
  if (burn === null || burn === undefined)
    return 'Pay as you go: what the computers cost an hour cannot be read right now.';
  const cost = `Pay as you go: the computers cost ${dollars(burn)} an hour now`;
  if (runway === 0)
    return `${cost}; the balance has run out, so nothing new can start until credits are added.`;
  if (runway === null || runway === undefined) return `${cost}.`;
  return `${cost}; the balance lasts about ${Math.floor(runway / 3600)} h at that rate.`;
}
