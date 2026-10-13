import { z } from 'zod';
import { NotFoundError } from '../errors.js';
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
  if (typeof url !== 'string' || !url.startsWith('https://')) return undefined;
  if (typeof label !== 'string' || !label) return undefined;
  if (typeof port !== 'number' || !Number.isSafeInteger(port) || port < 1 || port > 65535)
    return undefined;
  if (access !== 'public' && access !== 'private') return undefined;
  // Absent from nothing the platform has ever sent, but a URL with no word on
  // whether it is turned off is not one to call answering.
  if (typeof disabled !== 'boolean') return undefined;
  return { id, url, label, port, access, disabled };
}

/** Who can open it, in the words a model acts on. */
const reach = (u: PublicUrl): string =>
  u.access === 'public'
    ? 'PUBLIC: anyone with the link can open it'
    : 'private: only requests with an API key of this account as `Authorization: Bearer` open it, and the key never reaches the app';

/** One URL in a line, for a listing. */
const line = (u: PublicUrl): string =>
  `${u.url} → port ${u.port}, ${u.access}${u.disabled ? ' — TURNED OFF BY THE PLATFORM: it answers 404 until the platform turns it back on' : ''}  (${u.id})`;

/**
 * What a browser sees, said once in the create: the platform shows a one-time
 * notice page before a URL whose account is new, and a model driving a real
 * browser at its own URL can skip it.
 */
const BROWSERS =
  'A browser opening a URL whose account is new may first see a one-time notice page from Mandala Computer; when you drive a browser at it yourself, send the header `mandala-skip-warning: 1` to go straight to the app. Requests from programs never see the page.';

export const registerPublicUrls: Registrar = (server, session) => {
  server.registerTool(
    'list_public_urls',
    {
      title: 'List a computer’s public URLs',
      description:
        'The public URLs of one computer, oldest first: each is `https://<label>.<base_domain>` serving a port inside the computer, public (anyone with the link) or private (an API key of this account). Also says whether they can answer here at all — `enabled` is false, with a reason, where public URLs are off or the account’s plan includes none, and the URLs are listed either way so you can delete them — and how many this computer may have. If the plan drops below the number a computer has, the oldest within the limit keep answering and the rest answer 404.',
      inputSchema: idArg,
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
          typeof body.limit !== 'number'
        ) {
          return refused(
            `GET the public URLs of ${id} answered with ${shapeOf(body)}, not a listing. This is not a computer with no public URLs — do not create one on the strength of it.`,
            body,
          );
        }
        const rows = body.public_urls.map(publicUrlOf);
        const list = rows.filter((u): u is PublicUrl => u !== undefined);
        const malformed = rows.length - list.length;
        const warning = malformed
          ? `WARNING: ignored ${malformed} malformed public URL entr${malformed === 1 ? 'y' : 'ies'} from the platform.\n\n`
          : '';
        const off = body.enabled
          ? ''
          : `PUBLIC URLS DO NOT ANSWER HERE: ${typeof body.reason === 'string' && body.reason ? body.reason : 'no reason given'}. `;
        if (!list.length) {
          if (malformed) {
            return refused(
              `${warning}No valid public URLs remained for ${id}. This is not a computer with none — do not create one on the strength of a malformed listing.`,
              body,
            );
          }
          return said(
            `${warning}${off}No public URLs on ${id}. ${body.enabled ? `create_public_url makes one; this computer may have ${body.limit}.` : ''}`.trimEnd(),
            body,
          );
        }
        return said(
          `${warning}${off}${list.length} public URL${list.length === 1 ? '' : 's'} on ${id} (this computer may have ${body.limit}), oldest first:\n${list.map(line).join('\n')}`,
          body,
        );
      }),
  );

  server.registerTool(
    'create_public_url',
    {
      title: 'Serve a port on a public URL',
      description:
        'Serve a port inside the computer at `https://<label>.<base_domain>` (e.g. `https://brave-otter-3f2a.mandala.dev`), on 443 with no port in the address. PUBLIC BY DEFAULT: anyone on the internet with the link can open it — pass access: "private" to require an API key of this account instead. The app must listen on 0.0.0.0:<port>, not 127.0.0.1. Without a label one is picked. A label is 3 to 40 letters, digits and hyphens, and the platform refuses names that read as its own or another company’s (www, login, brand names and their look-alikes) with a 400 that says why. Other refusals: 402 when the plan includes no public URLs, 409 when the label is taken or the computer has as many as its plan allows (Solo 2, Studio 5, Swarm 10), 429 after too many in a day. Responses are marked noindex, cookies the app sets stay on its own host name, and a Mandala API key sent to a public URL never reaches the app. Not idempotent: a retry after a lost answer makes a second URL — list_public_urls first.',
      inputSchema: {
        ...idArg,
        port: portArg('create'),
        label: z
          .string()
          .optional()
          .describe(
            'The name before the domain, lowercased. Leave it out to have one like `brave-otter-3f2a` picked.',
          ),
        access: accessArg('create').optional(),
      },
    },
    ({ computer_id, port, label, access }, extra) =>
      guarded(async () => {
        const id = session.resolve(computer_id);
        const sent = P.publicUrlBody({ port, label, access });
        const body = await session.api
          .with(extra.signal)
          .json<unknown>('POST', P.publicUrls(id), { body: sent });
        const u = publicUrlOf(body);
        if (!u) {
          return refused(
            `The create on ${id} answered with ${shapeOf(body)}, not a public URL. THE URL MAY HAVE BEEN CREATED — call list_public_urls for ${id} rather than creating a second one.`,
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
      inputSchema: {
        ...idArg,
        ...urlIdArg,
        port: portArg('update').optional(),
        access: accessArg('update').optional(),
      },
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
        const body = await session.api
          .with(extra.signal)
          .json<unknown>('PATCH', P.publicUrl(id, url_id), { body: sent });
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
        'The URL stops answering at once, and its label becomes free for anyone to take unless the platform has blocked it. The app inside the computer keeps running. Irreversible: a new URL is a new id, and the old label may be gone by then.',
      inputSchema: {
        ...idArg,
        ...urlIdArg,
        confirm: z
          .literal(true)
          .describe('Must be true. The URL stops answering and its label is released.'),
      },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    ({ computer_id, url_id }, extra) =>
      guarded(async () => {
        const id = session.resolve(computer_id);
        let res: unknown;
        try {
          res = await session.api.with(extra.signal).send('DELETE', P.publicUrl(id, url_id));
        } catch (err) {
          // A 404 is the state this call asked for, and the tool is annotated
          // idempotent, so the retry after a lost 2xx is one a client may make.
          // Said as a success but not as "Deleted": the same 404 answers an id
          // that was never on this computer, and "deleted" over a mistyped id
          // leaves a real URL answering. delete_webhook answers the same way.
          if (!(err instanceof NotFoundError)) throw err;
          return said(
            `Nothing was deleted: ${id} has no public URL with the id ${url_id}. Either it was already removed — if this is a retry, the first call is the one that did it — or the id is wrong, in which case NO URL has been touched and the one you meant may still be answering. list_public_urls for ${id} says which.`,
          );
        }
        return said(
          `Deleted ${url_id} from ${id}. It no longer answers, and its label is free.`,
          res,
        );
      }),
  );
};
