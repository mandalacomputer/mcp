import { z } from 'zod';
import { APIError, NotFoundError } from '../errors.js';
import { guarded, refused, said } from '../format.js';
import * as P from '../paths.js';
import type { Registrar } from './types.js';

/**
 * The credential gateway: a secret from the account's store, added by the
 * platform as `Authorization: Bearer <secret>` to the guest's requests for one
 * exact HTTPS origin, path prefix and set of methods. The guest never holds
 * the secret: it calls the binding's `base_url` with a placeholder Bearer
 * token, and the platform makes the real request.
 *
 * Per computer, like public URLs: each tool takes a `computer_id` and falls
 * back to the one selected with use_computer.
 *
 * What a model most needs, and is told in the sentence before the JSON: how
 * the guest calls through the binding (the `base_url` and placeholder the
 * platform answered, never ones written in here), that the secret itself never
 * reaches the computer, and that a binding cannot be changed, only revoked and
 * made again.
 */

const idArg = {
  computer_id: z
    .string()
    .optional()
    .describe('Which computer. Defaults to the one selected with use_computer.'),
};

const bindingIdArg = {
  binding_id: z
    .string()
    .describe(
      'The binding’s id — `cgw-` and 24 hex characters, from list_credential_gateway_bindings.',
    ),
};

/** How many bindings one computer may have. */
const MAX_BINDINGS = 8;

/** One binding, checked: every field a sentence reads, or nothing. */
type Binding = {
  id: string;
  computer_id: string;
  secret_id: string;
  origin: string;
  path_prefix: string;
  methods: string[];
  base_url: string;
  placeholder: string;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const shapeOf = (v: unknown): string =>
  v === undefined ? 'no body at all' : v === null ? 'null' : Array.isArray(v) ? 'a list' : typeof v;

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v !== '';

/** An http(s) URL with a host: what a guest can actually send a request to. */
function reachable(v: unknown): v is string {
  if (!nonEmpty(v)) return false;
  try {
    const u = new URL(v);
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname;
  } catch {
    return false;
  }
}

/**
 * A binding the platform answered, or undefined if it is not one this server
 * can describe. Strict, because the sentences below tell a model where to
 * send requests and which origin and methods carry the secret: a body missing
 * any of those would be assembled from fallbacks and stated as fact.
 */
function bindingOf(v: unknown): Binding | undefined {
  if (!isRecord(v)) return undefined;
  const { id, computer_id, secret_id, origin, path_prefix, methods, base_url, placeholder } = v;
  if (!nonEmpty(id) || !nonEmpty(computer_id) || !nonEmpty(secret_id)) return undefined;
  if (!nonEmpty(origin) || !origin.startsWith('https://')) return undefined;
  if (!nonEmpty(path_prefix) || !path_prefix.startsWith('/')) return undefined;
  if (!Array.isArray(methods) || !methods.length || !methods.every(nonEmpty)) return undefined;
  if (!reachable(base_url) || !nonEmpty(placeholder)) return undefined;
  return {
    id,
    computer_id,
    secret_id,
    origin,
    path_prefix,
    methods: methods as string[],
    base_url,
    placeholder,
  };
}

/** The base URL with the provider path after it, without a doubled slash. */
const through = (b: Binding): string => `${b.base_url.replace(/\/+$/, '')}${b.path_prefix}`;

/** What it allows, in one clause. */
const scope = (b: Binding): string =>
  `${b.methods.join(', ')} to ${b.origin}${b.path_prefix === '/' ? ' (any path)' : `${b.path_prefix} and below`}, using secret ${b.secret_id}`;

const line = (b: Binding): string =>
  `${b.id}: ${scope(b)} — inside the computer call ${through(b)}… with \`Authorization: Bearer ${b.placeholder}\``;

/** How the guest uses a binding, said once in the create. */
const HOW =
  'Only non-browser HTTP clients work through it (curl, an SDK with its base URL set): no redirects, streaming, WebSocket upgrades or automatic retries; 1 MiB per request, 4 MiB per response, 30 seconds, two calls at a time. A call that fails after it was sent may still have done its work at the provider: check before retrying.';

/**
 * A change whose answer could not be read: anything but an HTTP answer from
 * the platform — an empty or non-JSON 2xx, a connection cut after the request
 * went, a cancellation. The platform may have done it, so the caller is sent
 * to the listing rather than told it failed: a create retried blind makes a
 * second binding. An HTTP refusal is not this, and keeps its own advice.
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

export const registerCredentialGateway: Registrar = (server, session) => {
  server.registerTool(
    'list_credential_gateway_bindings',
    {
      title: 'List a computer’s credential gateway bindings',
      description: `The credential gateway bindings of one computer: for each, the secret it uses (its id, never its value), the HTTPS origin, path prefix and methods it allows, and the \`base_url\` and placeholder the computer calls it with. Owners and members may read them. A computer may have up to ${MAX_BINDINGS}.`,
      inputSchema: z.strictObject(idArg),
      annotations: { readOnlyHint: true },
    },
    ({ computer_id }, extra) =>
      guarded(async () => {
        const id = session.resolve(computer_id);
        const body = await session.api
          .with(extra.signal)
          .json<unknown>('GET', P.credentialGateway(id));
        if (!isRecord(body) || !Array.isArray(body.bindings)) {
          return refused(
            `GET the credential gateway bindings of ${id} answered with ${shapeOf(body)}, not a listing. This is not a computer with no bindings — do not create one on the strength of it.`,
            body,
          );
        }
        // Strict: one row that is not a binding fails the listing rather than
        // being dropped. A dropped row is a secret the computer can still use,
        // left out of the one answer a caller reads to find out which.
        const rows = body.bindings.map(bindingOf);
        const malformed = rows.filter((b) => b === undefined).length;
        if (malformed) {
          return refused(
            `GET the credential gateway bindings of ${id} answered with ${malformed} entr${malformed === 1 ? 'y' : 'ies'} that ${malformed === 1 ? 'is' : 'are'} not a binding, so this listing cannot be read. It is not evidence about which secrets ${id} can use. Do not create or delete one on the strength of it; try list_credential_gateway_bindings again.`,
            body,
          );
        }
        const list = rows as Binding[];
        if (!list.length) {
          return said(
            `No credential gateway bindings on ${id}. create_credential_gateway_binding makes one; a computer may have ${MAX_BINDINGS}.`,
            body,
          );
        }
        return said(
          `${list.length} credential gateway binding${list.length === 1 ? '' : 's'} on ${id} (of ${MAX_BINDINGS} allowed):\n${list.map(line).join('\n')}`,
          body,
        );
      }),
  );

  server.registerTool(
    'create_credential_gateway_binding',
    {
      title: 'Let a computer use a secret through the credential gateway',
      description:
        'Let programs inside the computer call an HTTPS API with a secret from the account’s store (create_secret) WITHOUT the secret ever reaching the computer. The platform adds the secret as `Authorization: Bearer <secret>` to requests the computer sends to the answered `base_url` followed by the provider path, with `Authorization: Bearer <placeholder>` (the placeholder is in the answer), and only for the given exact `https://` origin (port 443, no path), path prefix (matched at segment boundaries) and methods. For example, origin `https://api.github.com`, path_prefix `/repos/acme/app` and methods `["GET"]` lets the computer GET `<base_url>/repos/acme/app/issues`. The platform uses the secret’s latest value on every call. Owners only; needs a paid or trial account with secrets enabled and a secret in the computer’s workspace or account. Up to 8 per computer (409 past that). A binding cannot be changed: delete it and create another. Clones do not inherit bindings; moving the computer to another workspace or owner removes them. Not idempotent: a retry after a lost answer makes a second binding — list_credential_gateway_bindings first. Use a narrowly scoped provider key: code inside the computer can make any request the binding allows.',
      // Strict: a misspelled field stripped as unknown would be a binding made
      // without what the caller meant to say, or an argument the platform's
      // body allowlist refuses anyway.
      inputSchema: z.strictObject({
        ...idArg,
        secret_id: z
          .string()
          .describe(
            'The secret to use — `csec-` and sixteen hex, from list_secrets or create_secret.',
          ),
        origin: z
          .string()
          .describe(
            'The exact HTTPS origin the secret may be sent to, e.g. `https://api.github.com`: no path, query, fragment, credentials or port.',
          ),
        path_prefix: z
          .string()
          .describe(
            'The absolute path prefix allowed under that origin, matched at segment boundaries (`/v1` allows `/v1` and `/v1/...`, not `/v10`). `/` allows every path.',
          ),
        methods: z
          .array(z.enum(P.CREDENTIAL_GATEWAY_METHODS))
          .min(1)
          .max(P.CREDENTIAL_GATEWAY_METHODS.length)
          .describe('The HTTP methods allowed, each once: GET, HEAD, POST, PUT, PATCH, DELETE.'),
      }),
    },
    ({ computer_id, secret_id, origin, path_prefix, methods }, extra) =>
      guarded(async () => {
        const sent = P.credentialGatewayBody({ secret_id, origin, path_prefix, methods });
        const id = session.resolve(computer_id);
        const path = P.credentialGateway(id);
        const got = await changed(
          () => session.api.with(extra.signal).send<unknown>('POST', path, { body: sent }),
          (why) =>
            refused(
              `The create on ${id} could not be read back (${why}). THE BINDING MAY HAVE BEEN CREATED — call list_credential_gateway_bindings for ${id} before creating another.`,
            ),
        );
        if ('refusal' in got) return got.refusal;
        const body = got.value;
        const b = bindingOf(body);
        if (!b) {
          return refused(
            `The create on ${id} answered with ${shapeOf(body)}, not a credential gateway binding. THE BINDING MAY HAVE BEEN CREATED — call list_credential_gateway_bindings for ${id} rather than creating a second one.`,
            body,
          );
        }
        return said(
          `Created ${b.id} on ${id}: ${scope(b)}. Inside the computer, send requests to ${through(b)}… (the base_url ${b.base_url} followed by the provider path) with \`Authorization: Bearer ${b.placeholder}\`; the platform replaces it with the secret. The secret never reaches the computer. ${HOW}`,
          body,
        );
      }),
  );

  server.registerTool(
    'delete_credential_gateway_binding',
    {
      title: 'Revoke a credential gateway binding',
      description:
        'Revoke one of a computer’s credential gateway bindings. Requests not yet sent to the provider can no longer use the secret; one already sent may finish. The secret itself stays in the account’s store. Owners only.',
      inputSchema: z.strictObject({
        ...idArg,
        ...bindingIdArg,
        confirm: z
          .literal(true)
          .describe('Must be true. Programs inside the computer lose the binding at once.'),
      }),
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    ({ computer_id, binding_id }, extra) =>
      guarded(async () => {
        const id = session.resolve(computer_id);
        const path = P.credentialGatewayBinding(id, binding_id);
        let res: unknown;
        try {
          res = await session.api.with(extra.signal).send('DELETE', path);
        } catch (err) {
          if (!(err instanceof APIError)) {
            const why = err instanceof Error ? err.message : String(err);
            return refused(
              `The delete of ${binding_id} could not be read back (${why}). IT MAY OR MAY NOT HAVE BEEN REVOKED — call list_credential_gateway_bindings for ${id} to see whether it is still there before telling anyone the computer can no longer use the secret.`,
            );
          }
          // A 404 is the state this call asked for, and the tool is annotated
          // idempotent, so it is said as a success — but not as "Revoked": the
          // same 404 answers a mistyped id, or a computer this key cannot see.
          if (!(err instanceof NotFoundError)) throw err;
          return said(
            `Nothing was revoked: the platform found no credential gateway binding ${binding_id} on ${id} that this key can reach. Either it was already removed — if this is a retry, the first call is the one that did it — or the binding id is wrong, or ${id} is not a computer this key can see. In the last two cases NO binding has been touched and the one you meant may still be in use. list_credential_gateway_bindings for ${id} says which.`,
          );
        }
        // The platform's ack, checked before saying the binding is gone.
        if (!isRecord(res) || res.ok !== true) {
          return refused(
            `The delete of ${binding_id} answered with ${shapeOf(res)}, not the platform's acknowledgment. IT MAY OR MAY NOT HAVE BEEN REVOKED — call list_credential_gateway_bindings for ${id} to see whether it is still there.`,
            res,
          );
        }
        return said(
          `Revoked ${binding_id} on ${id}. Requests not yet sent can no longer use its secret; the secret stays in the account’s store.`,
          res,
        );
      }),
  );
};
