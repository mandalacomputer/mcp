import { z } from 'zod';
import { APIError, NotFoundError } from '../errors.js';
import { guarded, refused, said } from '../format.js';
import * as P from '../paths.js';
import type { Registrar } from './types.js';

/**
 * Public URLs (platform OPL-3753): a port inside a computer served at
 * `https://<label>.<base_domain>` (e.g. `mandala.dev`), on 443 with no port in
 * the address, for a model to show a person the app it just started, or to
 * test that app the way a browser would.
 *
 * Per computer, like the SSH setting: each tool takes a `computer_id` and
 * falls back to the one selected with use_computer.
 *
 * What a model most needs to be told, and is told in the sentence before the
 * JSON rather than left to the schema: a `public` URL is reachable by anyone
 * on the internet who has the link, and the app must listen on 0.0.0.0, not
 * 127.0.0.1, or the URL answers nothing.
 */

const idArg = {
  computer_id: z
    .string()
    .optional()
    .describe('Which computer. Defaults to the one selected with use_computer.'),
};

const urlIdArg = {
  url_id: z.string().describe('The public URL’s id — `pu-` and sixteen hex characters.'),
};

const portArg = (on: 'create' | 'update') =>
  z
    .number()
    .int()
    .min(1)
    .max(65535)
    .describe(
      `${on === 'create' ? 'The port inside the computer to serve' : 'A new port for the URL to serve'}, 1 to 65535 except 22, which is the computer’s own SSH. The app must listen on 0.0.0.0:<port>, not 127.0.0.1.`,
    );

const accessArg = (on: 'create' | 'update') =>
  z
    .enum(['public', 'private'])
    .describe(
      on === 'create'
        ? '`public` (the default): ANYONE WITH THE LINK can open it. `private`: only a request carrying an API key of this account as `Authorization: Bearer` can, and the key never reaches the app.'
        : '`public`: anyone with the link can open it. `private`: only a request carrying an API key of this account as `Authorization: Bearer` can.',
    );

/** One public URL, checked: every field a sentence reads, or nothing. */
type PublicUrl = {
  id: string;
  url: string;
  label: string;
  port: number;
  access: 'public' | 'private';
  disabled: boolean;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const shapeOf = (v: unknown): string =>
  v === undefined ? 'no body at all' : v === null ? 'null' : Array.isArray(v) ? 'a list' : typeof v;

/**
 * A public URL the platform answered, or undefined if it is not one this
 * server can describe. Strict, because every sentence below is a claim about
 * the internet: "anyone with the link can open https://…" over a body with no
 * `url` or no `access` would be assembled from fallbacks and stated as fact.
 */
function publicUrlOf(v: unknown): PublicUrl | undefined {
  if (!isRecord(v)) return undefined;
  const { id, url, label, port, access, disabled } = v;
  if (typeof id !== 'string' || !id) return undefined;
  if (typeof label !== 'string' || !label) return undefined;
  if (!linkFor(url, label)) return undefined;
  if (typeof port !== 'number' || !Number.isSafeInteger(port) || port < 1 || port > 65535)
    return undefined;
  if (access !== 'public' && access !== 'private') return undefined;
  // Absent from nothing the platform has ever sent, but a URL with no word on
  // whether it is turned off is not one to call answering.
  if (typeof disabled !== 'boolean') return undefined;
  return { id, url, label, port, access, disabled };
}

/**
 * Whether `url` is the link the platform promises for `label`: https, on 443
 * (no port), no credentials, and a host that is the label under a domain. A
 * prefix check let `https://` through, and a create answering it was reported
 * as a link anyone could open (Codex, round 2 on #212).
 */
function linkFor(url: unknown, label: string): url is string {
  if (typeof url !== 'string') return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.protocol === 'https:' &&
    !parsed.username &&
    !parsed.password &&
    !parsed.port &&
    parsed.hostname.startsWith(`${label}.`) &&
    parsed.hostname.length > label.length + 1
  );
}

/**
 * Who can open it, in the words a model acts on. A URL the platform has turned
 * off opens for nobody, whatever its access says, so that comes first: a
 * create or an update answering `disabled: true` is not a URL anyone can open
 * (Codex, round 1 on #212).
 */
const reach = (u: PublicUrl): string =>
  u.disabled
    ? `TURNED OFF BY THE PLATFORM: it answers 404 to everyone until the platform turns it back on (its access is set to ${u.access})`
    : u.access === 'public'
      ? 'PUBLIC: anyone with the link can open it'
      : 'private: only requests with an API key of this account as `Authorization: Bearer` open it, and the key never reaches the app';

/**
 * One URL in a line, for a listing. `past` is a URL beyond the computer's
 * limit as the plan stands now: the oldest `limit` answer and the rest answer
 * 404, counted over every URL of the computer in the listing's order, oldest
 * first — so a row's place in the listing is what decides it.
 */
const line = (u: PublicUrl, past: number | undefined): string =>
  `${u.url} → port ${u.port}, ${u.access}${u.disabled ? ' — TURNED OFF BY THE PLATFORM: it answers 404 until the platform turns it back on' : ''}${past === undefined ? '' : ` — PAST THIS COMPUTER\u2019S LIMIT OF ${past}: it answers 404 until the plan allows it again; only the oldest ${past} answer`}  (${u.id})`;

/**
 * What a browser sees, said once in the create: the platform shows a one-time
 * notice page before a URL whose account is new. Who gets it is decided by the
 * request's headers, not by whether a program sent it: a page navigation by
 * fetch metadata, or, without fetch metadata, `Accept: text/html` from a
 * `Mozilla/` user agent. So a program sending a browser's headers sees it too,
 * and the guest's own browser cannot add the skip header, so there the way
 * past it is the page's own Continue.
 */
const BROWSERS =
  'A browser opening a URL whose account is new may first see a one-time notice page from Mandala Computer, once per URL per browser. It is shown to any request that looks like a browser opening a page — a navigation by its fetch metadata, or, without fetch metadata, `Accept: text/html` from a `Mozilla/` user agent — so a program that sends browser headers gets it too, and one that does not gets the app. A client that sets its own headers skips it by sending `mandala-skip-warning: 1`. open_url cannot send headers: in the computer\u2019s own browser, click Continue on the page to go on to the app.';

/**
 * A change whose answer could not be read: a create, an update or a delete
 * that failed for any reason other than an HTTP answer from the platform — an
 * empty, `null` or non-JSON 2xx, a connection cut after the request went, a
 * cancellation. The platform may have done it, so the caller is sent to the
 * listing rather than told it failed: a create retried blind makes a second
 * URL open to anyone, and the first goes on answering, untracked (Codex, round
 * 3 on #212). An HTTP refusal is not this, and keeps its own advice.
 */
async function changed<T>(
  attempt: () => Promise<T>,
  unknownOutcome: (why: string) => ReturnType<typeof refused>,
): Promise<{ value: T } | { refusal: ReturnType<typeof refused> }> {
  try {
    return { value: await attempt() };
  } catch (err) {
    if (err instanceof APIError) throw err;
    return { refusal: unknownOutcome(err instanceof Error ? err.message : String(err)) };
  }
}

export const registerPublicUrls: Registrar = (server, session) => {
  server.registerTool(
    'list_public_urls',
    {
      title: 'List a computer’s public URLs',
      description:
        'The public URLs of one computer, oldest first: each is `https://<label>.<base_domain>` serving a port inside the computer, public (anyone with the link) or private (an API key of this account). Also says whether they can answer here at all — `enabled` is false, with a reason, where public URLs are off or the account’s plan includes none, and the URLs are listed either way so you can delete them — and how many this computer may have. If the plan drops below the number a computer has, the oldest within the limit keep answering and the rest answer 404.',
      inputSchema: z.object(idArg).strict(),
      annotations: { readOnlyHint: true },
    },
    ({ computer_id }, extra) =>
      guarded(async () => {
        const id = session.resolve(computer_id);
        const body = await session.api.with(extra.signal).json<unknown>('GET', P.publicUrls(id));
        if (
          !isRecord(body) ||
          typeof body.enabled !== 'boolean' ||
          !Array.isArray(body.public_urls) ||
          typeof body.base_domain !== 'string' ||
          typeof body.limit !== 'number' ||
          !Number.isSafeInteger(body.limit) ||
          body.limit < 0
        ) {
          return refused(
            `GET the public URLs of ${id} answered with ${shapeOf(body)}, not a listing. This is not a computer with no public URLs — do not create one on the strength of it.`,
            body,
          );
        }
        const limit = body.limit;
        // Strict, like every other decoder here (OPL-5975): one row that is
        // not a public URL fails the listing rather than being dropped. A
        // dropped row is a URL that may be answering, left out of the one
        // answer a caller reads to find out what is exposed — and it would
        // shift every later row's place, which is what decides which of them
        // are past the limit.
        const rows = body.public_urls.map(publicUrlOf);
        const malformed = rows.filter((u) => u === undefined).length;
        if (malformed) {
          return refused(
            `GET the public URLs of ${id} answered with ${malformed} entr${malformed === 1 ? 'y' : 'ies'} that ${malformed === 1 ? 'is' : 'are'} not a public URL, so this listing cannot be read. It is not evidence about what ${id} exposes: any of its URLs may be answering. Do not create or delete one on the strength of it; try list_public_urls again.`,
            body,
          );
        }
        const list = rows as PublicUrl[];
        const off = body.enabled
          ? ''
          : `PUBLIC URLS DO NOT ANSWER HERE: ${typeof body.reason === 'string' && body.reason ? body.reason : 'no reason given'}. `;
        if (!list.length) {
          return said(
            `${off}No public URLs on ${id}. ${body.enabled ? `create_public_url makes one; this computer may have ${limit}.` : ''}`.trimEnd(),
            body,
          );
        }
        // Past the limit only matters while URLs can answer at all: with
        // `enabled` false every one of them answers 404, and the line above
        // already says so.
        const past = body.enabled ? list.length - Math.min(list.length, limit) : 0;
        return said(
          `${off}${list.length} public URL${list.length === 1 ? '' : 's'} on ${id} (this computer may have ${limit}), oldest first:${past ? ` ${past} of them ${past === 1 ? 'is' : 'are'} past that limit and answer${past === 1 ? 's' : ''} 404 until the plan allows ${past === 1 ? 'it' : 'them'} again — delete URLs you no longer need, oldest you do not want first, to bring the rest within it.` : ''}\n${list
            .map((u, i) => line(u, body.enabled && i >= limit ? limit : undefined))
            .join('\n')}`,
          body,
        );
      }),
  );

  server.registerTool(
    'create_public_url',
    {
      title: 'Serve a port on a public URL',
      description:
        'Serve a port inside the computer at `https://<label>.<base_domain>` (e.g. `https://brave-otter-3f2a.mandala.dev`), on 443 with no port in the address. PUBLIC BY DEFAULT: anyone on the internet with the link can open it — pass access: "private" to require an API key of this account instead. The app must listen on 0.0.0.0:<port>, not 127.0.0.1. Without a label one is picked. A label is 3 to 40 letters, digits and hyphens, and the platform refuses names that read as its own or another company’s (www, login, brand names and their look-alikes) with a 400 that says why. Other refusals: 402 when the plan includes no public URLs; 403 PUBLIC_URLS_BLOCKED when the platform has turned public URLs off for this computer or account (not a role, and not something to retry — tell the user); 404 PUBLIC_URLS_DISABLED when public URLs are not enabled here at all (not a missing computer); 409 LABEL_TAKEN when the label is taken — a label is never given to a second account, so one another account has ever held, or one the platform has blocked, reads as taken — and 409 PUBLIC_URL_LIMIT when the computer has as many as its plan allows (Solo 2, Studio 5, Swarm 10); neither 409 clears by waiting. 429 after too many in a day, with Retry-After. Responses are marked noindex, cookies the app sets stay on its own host name, and a Mandala API key sent to a public URL never reaches the app. Not idempotent: a retry after a lost answer makes a second URL — list_public_urls first.',
      inputSchema: z
        .object({
          ...idArg,
          port: portArg('create'),
          label: z
            .string()
            .optional()
            .describe(
              'The name before the domain, lowercased. Leave it out to have one like `brave-otter-3f2a` picked.',
            ),
          access: accessArg('create').optional(),
        })
        // Strict, above all here: a misspelled `access: "private"` stripped
        // as an unknown key would create a URL anyone can open (Codex, round
        // 1 on #212). Every tool in this file refuses an argument it does not
        // know, rather than acting without it.
        .strict(),
    },
    ({ computer_id, port, label, access }, extra) =>
      guarded(async () => {
        const id = session.resolve(computer_id);
        const sent = P.publicUrlBody({ port, label, access });
        const path = P.publicUrls(id);
        const got = await changed(
          () => session.api.with(extra.signal).send<unknown>('POST', path, { body: sent }),
          (why) =>
            refused(
              `The create on ${id} could not be read back (${why}). THE URL MAY HAVE BEEN CREATED, and if it was, it is ${sent.access === 'private' ? 'private' : 'open to anyone with the link'} — call list_public_urls for ${id} before creating another.`,
            ),
        );
        if ('refusal' in got) return got.refusal;
        const body = got.value;
        const u = publicUrlOf(body);
        if (!u) {
          return refused(
            `The create on ${id} answered with ${shapeOf(body)}, not a public URL. THE URL MAY HAVE BEEN CREATED, and if it was, it is ${sent.access === 'private' ? 'private' : 'open to anyone with the link'} — call list_public_urls for ${id} rather than creating a second one.`,
            body,
          );
        }
        return said(
          `Created ${u.url}, serving port ${u.port} inside ${id}. ${reach(u)}. The app must listen on 0.0.0.0:${u.port}, not 127.0.0.1. ${BROWSERS}`,
          u,
        );
      }),
  );

  server.registerTool(
    'update_public_url',
    {
      title: 'Change a public URL’s port or access',
      description:
        'Point a public URL at another port, switch it between public and private, or both. The label is the URL and does not change — delete it and create another for a new name. Fields you leave out are kept; name at least one.',
      inputSchema: z
        .object({
          ...idArg,
          ...urlIdArg,
          port: portArg('update').optional(),
          access: accessArg('update').optional(),
        })
        .strict(),
      annotations: { idempotentHint: true },
    },
    ({ computer_id, url_id, port, access }, extra) =>
      guarded(async () => {
        const sent = P.publicUrlBody({ port, access });
        if (!Object.keys(sent).length) {
          return refused(
            'Nothing to change: name a port, an access, or both. The platform refuses an empty update, so nothing was sent.',
          );
        }
        const id = session.resolve(computer_id);
        const path = P.publicUrl(id, url_id);
        const got = await changed(
          () => session.api.with(extra.signal).send<unknown>('PATCH', path, { body: sent }),
          (why) =>
            refused(
              `The update to ${url_id} could not be read back (${why}). THE CHANGE MAY HAVE LANDED — read it back with list_public_urls rather than assuming either way, since who can open the URL may have changed.`,
            ),
        );
        if ('refusal' in got) return got.refusal;
        const body = got.value;
        const u = publicUrlOf(body);
        if (!u) {
          return refused(
            `The update to ${url_id} answered with ${shapeOf(body)}, not a public URL. THE CHANGE MAY HAVE LANDED — read it back with list_public_urls rather than assuming either way, since who can open the URL may have changed.`,
            body,
          );
        }
        return said(`Updated ${u.url}: port ${u.port}. ${reach(u)}.`, u);
      }),
  );

  server.registerTool(
    'delete_public_url',
    {
      title: 'Remove a public URL',
      description:
        'The URL stops answering at once. Its label stays with this account: no other account can ever take it, and this account may use it again (create_public_url with that label) unless the platform has blocked it. The app inside the computer keeps running. A URL made again is a new id.',
      inputSchema: z
        .object({
          ...idArg,
          ...urlIdArg,
          confirm: z.literal(true).describe('Must be true. The URL stops answering at once.'),
        })
        .strict(),
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    ({ computer_id, url_id }, extra) =>
      guarded(async () => {
        const id = session.resolve(computer_id);
        const path = P.publicUrl(id, url_id);
        let res: unknown;
        try {
          res = await session.api.with(extra.signal).send('DELETE', path);
        } catch (err) {
          if (!(err instanceof APIError)) {
            const why = err instanceof Error ? err.message : String(err);
            return refused(
              `The delete of ${url_id} could not be read back (${why}). IT MAY OR MAY NOT HAVE BEEN DELETED — call list_public_urls for ${id} to see whether it is still there before telling anyone it no longer answers.`,
            );
          }
          // A 404 is the state this call asked for, and the tool is annotated
          // idempotent, so the retry after a lost 2xx is one a client may make.
          // Said as a success but not as "Deleted": the same 404 answers an id
          // that was never on this computer, and "deleted" over a mistyped id
          // leaves a real URL answering. delete_webhook answers the same way.
          if (!(err instanceof NotFoundError)) throw err;
          // Not "the id is wrong" alone: the platform answers the same 404 for
          // a computer this key cannot see — another workspace's, or one that
          // is gone — before it looks for the URL at all.
          return said(
            `Nothing was deleted: the platform found no public URL ${url_id} on ${id} that this key can reach. Either it was already removed — if this is a retry, the first call is the one that did it — or the URL id is wrong, or ${id} is not a computer this key can see (another workspace's, or gone). In the last two cases NO URL has been touched and the one you meant may still be answering. list_public_urls for ${id} says which.`,
          );
        }
        // The platform's ack, checked before saying the exposure ended: a 2xx
        // that is not `{ ok: true }` is not evidence the URL stopped answering
        // (Codex, round 1 on #212).
        if (!isRecord(res) || res.ok !== true) {
          return refused(
            `The delete of ${url_id} answered with ${shapeOf(res)}, not the platform's acknowledgment. IT MAY OR MAY NOT HAVE BEEN DELETED — call list_public_urls for ${id} to see whether it is still there before telling anyone it no longer answers.`,
            res,
          );
        }
        return said(
          `Deleted ${url_id} from ${id}. It no longer answers. Its label stays with this account: no other account can take it, and you may use it again unless the platform has blocked it.`,
          res,
        );
      }),
  );
};
