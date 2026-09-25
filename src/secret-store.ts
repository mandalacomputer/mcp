/**
 * The account's secret store, as the platform answers it (OPL-4984 part 2).
 *
 * A secret is a named value, encrypted when saved and never readable again: no
 * route answers a value, so none of the shapes here has one. Computers are bound
 * to secrets by id with `PUT computers/:id/secrets`; this is where those ids,
 * and the revision a replace or delete needs, come from.
 *
 * Decoded strictly. Every field the published schema marks required is checked,
 * and a decoded secret carries exactly those fields — so an answer that somehow
 * held a `value` could not carry it any further than the decoder.
 */

import { MandalaError } from './errors.js';

/** One secret, without its value. */
export type Secret = {
  /** `csec-` and sixteen hex characters: what a binding names as `secret_id`. */
  id: string;
  /** Unique within its scope. */
  name: string;
  /** The workspace it belongs to, or `null` for one available account-wide. */
  workspace_id: string | null;
  /** Moves every time the value is replaced; a replace or delete sends back the one it read. */
  revision_id: string;
  created_at: string;
  /** The last replace, or the create. */
  updated_at: string;
  /** When it was last delivered to a computer; `null` until it has been. */
  last_used_at: string | null;
};

/** The store's limits, as `GET secrets` reports them. */
export type SecretLimits = {
  name_max_chars: number;
  value_max_bytes: number;
  /** How many the account may hold at once, across every workspace. Deleting frees a place. */
  active_per_account: number;
  /** How many the account may ever create, deleted ones included. Deleting does not free one. */
  created_per_account: number;
};

/** One scope's secrets, whether they can be bound here, and the limits. */
export type SecretList = {
  secrets: Secret[];
  /** Whether a secret can be bound to a computer on this platform; stored either way. */
  delivery: boolean;
  limits: SecretLimits;
};

/**
 * The store's five calls, as `Api.secrets` offers them.
 *
 * `workspaceId` names the scope: left out, the account-wide secrets; a key
 * confined to a workspace works in that workspace, and naming another is a 403.
 */
export interface SecretStore {
  /** `GET secrets`: one scope's secrets, whether binding is on, and the limits. Never a value. */
  list(opts?: { workspaceId?: string }): Promise<SecretList>;
  /**
   * `POST secrets`: store a value under a name. Owners only; a taken name is a
   * 409 and the store's two limits are 400s. `workspaceId: null` or left out is
   * account-wide. NOT safe to repeat blind: a lost answer may be a secret that
   * now exists — list before creating again.
   */
  create(args: { name: string; value: string; workspaceId?: string | null }): Promise<Secret>;
  /** `GET secrets/:id`: one secret's name, scope and current revision, without its value. */
  get(id: string, opts?: { workspaceId?: string }): Promise<Secret>;
  /**
   * `PUT secrets/:id`: replace the value, conditional on `revisionId` — a stale
   * one is a 409 and nothing changed. Answers the secret at its new revision.
   * Owners only.
   */
  replace(
    id: string,
    args: { value: string; revisionId: string; workspaceId?: string | null },
  ): Promise<Secret>;
  /**
   * `DELETE secrets/:id`: delete it, conditional on `revisionId` (required; a
   * stale one is a 409 and nothing is deleted). Owners only. A computer still
   * bound to it cannot be given its secrets again: its next start is refused.
   */
  delete(id: string, args: { revisionId: string; workspaceId?: string }): Promise<void>;
}

/**
 * The refusal words the platform documents, and the only ones a secret-store
 * refusal is allowed to carry through this package. Taken from the published
 * `Error.reason` (contention, starting, unavailable, unsupported, exists,
 * revoked) and the API-key ingress words beside it (missing, invalid).
 *
 * An allow-list rather than a shape check, because a shape check is exactly
 * what a secret prefix passes: `sk-proj-abc…` cut to thirty-two characters is a
 * perfectly word-like string (OPL-5026 review). Any other word is dropped, not
 * shown — the status still says what kind of failure it was.
 */
export const DOCUMENTED_REASONS: ReadonlySet<string> = new Set([
  'contention',
  'starting',
  'unavailable',
  'unsupported',
  'exists',
  'revoked',
  'missing',
  'invalid',
]);

/**
 * A request id in the platform's own format: a random UUID, which is all it
 * mints (callers' ids are ignored). Anything else is not repeated.
 */
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Whether a string is a request id the platform could have minted. */
export const isRequestId = (v: unknown): v is string => typeof v === 'string' && REQUEST_ID.test(v);

/**
 * Whether two strings share any run of four or more characters — the test for
 * "this metadata may be a piece of that value". Used to drop even a documented
 * word or a well-formed id that happens to overlap the value sent.
 */
export function overlaps(a: string, b: string, run = 4): boolean {
  if (!a || !b) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < run) return long.includes(short);
  for (let i = 0; i + run <= short.length; i++) {
    if (long.includes(short.slice(i, i + run))) return true;
  }
  return false;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** An id or timestamp as the platform spells one: not empty, nothing around it. */
const isToken = (v: unknown): v is string => typeof v === 'string' && v !== '' && v.trim() === v;

const isCount = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** A secret, checked field by field, or `undefined`. Only the documented fields survive. */
export function secretOf(body: unknown): Secret | undefined {
  if (!isRecord(body)) return undefined;
  const { id, name, workspace_id, revision_id, created_at, updated_at, last_used_at } = body;
  if (!isToken(id) || !isToken(revision_id)) return undefined;
  if (typeof name !== 'string' || name === '') return undefined;
  if (workspace_id !== null && !isToken(workspace_id)) return undefined;
  if (!isToken(created_at) || !isToken(updated_at)) return undefined;
  if (last_used_at !== null && !isToken(last_used_at)) return undefined;
  return { id, name, workspace_id, revision_id, created_at, updated_at, last_used_at };
}

/** A listing, checked: every secret in it, the delivery flag and all four limits, or `undefined`. */
export function secretListOf(body: unknown): SecretList | undefined {
  if (!isRecord(body)) return undefined;
  const { secrets, delivery, limits } = body;
  if (!Array.isArray(secrets) || typeof delivery !== 'boolean' || !isRecord(limits))
    return undefined;
  const { name_max_chars, value_max_bytes, active_per_account, created_per_account } = limits;
  if (
    !isCount(name_max_chars) ||
    !isCount(value_max_bytes) ||
    !isCount(active_per_account) ||
    !isCount(created_per_account)
  )
    return undefined;
  const out: Secret[] = [];
  for (const row of secrets) {
    const secret = secretOf(row);
    if (!secret) return undefined;
    out.push(secret);
  }
  return {
    secrets: out,
    delivery,
    limits: { name_max_chars, value_max_bytes, active_per_account, created_per_account },
  };
}

/** The shape of an answer, for a sentence that says it was not the expected one. */
export const shapeOf = (v: unknown): string =>
  v === undefined ? 'no body at all' : v === null ? 'null' : Array.isArray(v) ? 'a list' : typeof v;

/**
 * An answer that arrived and is not the documented shape.
 *
 * For a change, `mutated` says so in the message: the platform may well have
 * made it, and the one thing a caller must not do is send it again on the
 * strength of a body this could not read.
 */
export function malformedSecretAnswer(what: string, body: unknown, mutated: boolean): MandalaError {
  return new MandalaError(
    `${what} answered with ${shapeOf(body)}, not the documented secret shape.${
      mutated
        ? ' THE CHANGE MAY HAVE BEEN MADE — read the secret back before sending it again.'
        : ''
    }`,
  );
}
