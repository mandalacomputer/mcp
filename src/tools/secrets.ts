import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { APIError, ConflictError, MandalaError, NotFoundError, statusAdvice } from '../errors.js';
import { guarded, refused, said, unavailableAdvice } from '../format.js';
import * as P from '../paths.js';
import {
  DOCUMENTED_REASONS,
  isRequestId,
  overlaps,
  type Secret,
  type SecretList,
} from '../secret-store.js';
import type { Registrar } from './types.js';

/**
 * Secrets: the account's store of named values, and which of them each
 * computer is bound to.
 *
 * The BINDINGS (get/set_computer_secrets) carry only ids, revision ids, env
 * names and file names — no value crosses those routes in either direction.
 *
 * The STORE (list/get/create/set/replace/delete_secret) is where a value goes in,
 * and only in: the platform never answers one, the decoded answers here carry
 * none, and a tool that took a value never repeats it — not in a success, not
 * in a refusal. See {@link withoutValue}.
 *
 * A change of bindings takes effect at the computer's NEXT START OR RESTART. A
 * running computer keeps what it booted with until then, and a suspended one
 * resumes with its old values; the sentences below say so every time, because a
 * model that reads "saved" as "delivered" goes on to use a credential the guest
 * does not have yet. What reaches a running computer sooner is a replaced VALUE:
 * a file binding's file is rewritten in place, and on an image that supports it
 * an env binding's new value reaches new shells and desktop-session commands.
 */

/** Where a file binding is published in the guest. */
export const FILES_DIR = '/run/mandala-secrets/user/files';

/** At most this many secrets per computer, and this many of them as files. */
export const SECRET_BINDINGS_MAX = 32;
export const SECRET_FILES_MAX = 8;
const SECRET_ENV = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const SECRET_FILE = /^[a-z][a-z0-9_-]{0,47}$/;

const ENV_RULE =
  'letters, digits and underscores, not starting with a digit, at most 64 characters';
const FILE_RULE =
  'lowercase letters, digits, - and _, starting with a letter, at most 48 characters';

/** An id as the platform spells one: not empty, and nothing around it. */
const isId = (v: unknown): v is string => typeof v === 'string' && v !== '' && v.trim() === v;

const idString = (what: string) =>
  z.string().refine(isId, `${what} must not be empty or have spaces around it`);

type BindingArg = { secret_id: string; env?: string; file?: string };

/**
 * A binding list as the platform takes it, checked here for what it would
 * refuse anyway — so the mistake is named against the entry that made it
 * rather than coming back as a 400. `revision` adds the optional `revision_id`
 * a rebind may send; a create has nothing to keep and takes none.
 */
export function secretBindingsSchema(revision: boolean) {
  // Strict: a key this tool does not take is refused, not dropped. A create
  // that carried a `revision_id` would otherwise validate, bind the latest, and
  // leave the caller believing it had chosen a revision.
  const entry = z.strictObject({
    secret_id: idString('secret_id').describe('The secret to bind — `csec-` and sixteen hex.'),
    env: z
      .string()
      .regex(SECRET_ENV, `env must be ${ENV_RULE}`)
      .optional()
      .describe(
        `Deliver it as this environment variable in the desktop session: ${ENV_RULE}. Exactly one of env and file.`,
      ),
    file: z
      .string()
      .regex(SECRET_FILE, `file must be ${FILE_RULE}`)
      .optional()
      .describe(
        `Deliver it as the file ${FILES_DIR}/<file>, for a program that reads a path (a kubeconfig, a key): ${FILE_RULE}. May hold any bytes. Exactly one of env and file.`,
      ),
    ...(revision
      ? {
          revision_id: idString('revision_id')
            .optional()
            .describe(
              'Omit to record the latest revision. Name the one the computer holds now to keep it: a revision is what the computer last received, not a pin, and every start or restart delivers the latest value regardless.',
            ),
        }
      : {}),
  });
  return z
    .array(entry)
    .max(SECRET_BINDINGS_MAX, `at most ${SECRET_BINDINGS_MAX} secrets per computer`)
    .superRefine((list: BindingArg[], ctx) => {
      const ids = new Set<string>();
      const envs = new Set<string>();
      const files = new Set<string>();
      list.forEach((b, i) => {
        const at = (message: string) => ctx.addIssue({ code: 'custom', path: [i], message });
        if ((b.env === undefined) === (b.file === undefined)) {
          at(`secrets[${i}] must name exactly one of env and file`);
        }
        if (ids.has(b.secret_id)) at(`secrets[${i}]: ${b.secret_id} is bound twice`);
        ids.add(b.secret_id);
        // Two namespaces: a variable and a file may share a spelling.
        if (b.env !== undefined) {
          if (envs.has(b.env)) at(`secrets[${i}].env ${b.env} is bound twice`);
          envs.add(b.env);
        }
        if (b.file !== undefined) {
          if (files.has(b.file)) at(`secrets[${i}].file ${b.file} is bound twice`);
          files.add(b.file);
        }
      });
      if (files.size > SECRET_FILES_MAX) {
        ctx.addIssue({ code: 'custom', message: `at most ${SECRET_FILES_MAX} secrets as files` });
      }
    });
}

const idArg = {
  computer_id: z
    .string()
    .optional()
    .describe('Which computer. Defaults to the one selected with use_computer.'),
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const shapeOf = (v: unknown): string =>
  v === undefined ? 'no body at all' : v === null ? 'null' : Array.isArray(v) ? 'a list' : typeof v;

/** Exactly one of `env` and `file`, as the platform records it. */
type Binding = { secret_id: string; revision_id: string } & (
  | { env: string; file?: undefined }
  | { file: string; env?: undefined }
);

/** The bindings and their version, checked: every field the sentence reads, or nothing. */
type Bindings = { secrets: Binding[]; version: number };

function bindingsOf(body: unknown): Bindings | undefined {
  if (!isRecord(body)) return undefined;
  const { secrets, version } = body;
  if (!Array.isArray(secrets)) return undefined;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0)
    return undefined;
  const out: Binding[] = [];
  for (const entry of secrets) {
    if (!isRecord(entry)) return undefined;
    const { secret_id, revision_id, env, file } = entry;
    if (!isId(secret_id) || !isId(revision_id)) return undefined;
    // Exactly one, spelled as the platform would accept it. Null reads as
    // absent; anything else present — an empty string included — counts, so a
    // row naming both or neither is refused rather than guessed at.
    const hasEnv = env !== undefined && env !== null;
    const hasFile = file !== undefined && file !== null;
    if (hasEnv === hasFile) return undefined;
    if (hasEnv) {
      if (typeof env !== 'string' || !SECRET_ENV.test(env)) return undefined;
      out.push({ secret_id, revision_id, env });
    } else {
      if (typeof file !== 'string' || !SECRET_FILE.test(file)) return undefined;
      out.push({ secret_id, revision_id, file });
    }
  }
  return { secrets: out, version };
}

/**
 * One binding in a line: where the guest finds it — a variable name, or a file's
 * full path — then what it is bound to.
 */
const bindingLine = (b: Binding): string =>
  `${b.env ?? `${FILES_DIR}/${b.file}`} = ${b.secret_id} @ ${b.revision_id}`;

const LEGEND = 'variable or file = secret @ revision, values never shown';

/** The bindings, one per line. Callers say "none" themselves for an empty list. */
function listing(b: Bindings): string {
  return `\n${b.secrets.map(bindingLine).join('\n')}`;
}

const TIMING =
  'The new bindings reach the guest at its NEXT START OR RESTART: a running computer keeps what it booted with until then, and a suspended one resumes with its old values.';

/**
 * What reaches a running computer without a restart: a replaced VALUE.
 *
 * Worded to hold whichever way the platform answers a plain exec. Today a plain
 * exec runs as root and is never given bound secrets; platform work under way
 * (OPL-5028) gives it the bound environment too. `desktop: true` sees them
 * either way, so that is the instruction, and the plain-exec case is stated as
 * something not to rely on rather than as a fact that is about to change.
 */
const LIVE_VALUES =
  "Every start and restart delivers each secret's latest value. Separately, when a secret's value is replaced on a running computer: a secret bound as a FILE has that file rewritten in place within seconds; one bound as an ENVIRONMENT VARIABLE, on an image that supports it, reaches new shells and exec commands run with desktop: true within seconds, while programs already running — the desktop session among them — keep the value they started with until a restart (older images wait for the restart). A command that needs a bound secret should run with desktop: true; do not rely on a plain exec seeing it. A file newly bound or renamed waits for the restart either way.";

/** A secret in a line: what a model recognises it by, and the revision a change needs. Never a value. */
const secretLine = (s: Secret): string =>
  `${s.name}  ${s.id}  revision ${s.revision_id}  ${s.workspace_id === null ? 'account-wide' : `workspace ${s.workspace_id}`}  ${s.last_used_at === null ? 'never delivered' : `last delivered ${s.last_used_at}`}`;

const STORE_LEGEND = 'name  id  revision  scope  last delivery; values are never shown';

/** The byte length of a value as the platform counts it: UTF-8. */
const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

/** The published ceiling on a value, in bytes of UTF-8. */
export const SECRET_VALUE_MAX_BYTES = 4096;
/** The published ceiling on a name, in characters. */
export const SECRET_NAME_MAX_CHARS = 60;

/**
 * A secret value as a tool argument.
 *
 * Checked here for what the platform would refuse anyway, with messages that
 * name the rule and never the value: a validation failure is shown to the model,
 * and the whole point of this argument is that it is not shown to anyone.
 */
const valueArg = (what: string) =>
  z
    .string()
    .refine(
      (v) => {
        const n = utf8Bytes(v);
        return n >= 1 && n <= SECRET_VALUE_MAX_BYTES;
      },
      { message: `value must be 1 to ${SECRET_VALUE_MAX_BYTES} bytes of UTF-8` },
    )
    .describe(
      `${what}, as text: 1 to ${SECRET_VALUE_MAX_BYTES} bytes of UTF-8. Sent to the platform once, encrypted there, and never shown again — not in this tool's answer, not by any other tool, not by any route.`,
    );

const secretIdArg = idString('secret_id').describe(
  'The secret — `csec-` and sixteen hex characters, from list_secrets.',
);

const workspaceArg = z
  .string()
  .refine(isId, 'workspace_id must not be empty or have spaces around it')
  .optional()
  .describe(
    'The workspace the secret belongs to. Leave it out for an account-wide secret. A secret in a workspace is found only with its workspace_id.',
  );

/** A secret's name as a tool argument, checked for what the platform would refuse. */
const nameArg = z
  .string()
  .min(1, 'name must not be empty')
  .refine((v) => [...v].length <= SECRET_NAME_MAX_CHARS, {
    message: `name must be at most ${SECRET_NAME_MAX_CHARS} characters`,
  })
  .refine((v) => !/\p{Cc}/u.test(v), {
    message: 'name must not contain control characters',
  })
  .describe(
    `What the secret is called, e.g. OPENAI_API_KEY. Up to ${SECRET_NAME_MAX_CHARS} characters, unique in its scope. This is a label, not where the value lands: set_computer_secrets names the variable or file.`,
  );

/** How many times set_secret reads the scope again after a conflict. */
export const SECRET_SET_RETRIES = 3;

/**
 * The secret called `name` in a listing of one scope, or `undefined`: trimmed
 * as the platform trims names, and ignoring ASCII case and nothing else, which
 * is how it keeps them unique — `openai_api_key` is taken when `OPENAI_API_KEY` is.
 */
export function namedSecret(secrets: readonly Secret[], name: string): Secret | undefined {
  const fold = (text: string) => text.trim().replace(/[A-Z]/g, (c) => c.toLowerCase());
  const wanted = fold(name);
  return secrets.find((s) => fold(s.name) === wanted);
}

const revisionArg = (use: string) =>
  idString('revision_id').describe(
    `The \`revision_id\` list_secrets or get_secret answered for this secret — \`csr-\` and twenty-four hex characters. ${use}`,
  );

/**
 * A tool result with every occurrence of a value taken out.
 *
 * The SECOND layer. The first is that no secret-store tool puts response text
 * in its answer at all — see {@link storeGuarded} — and the Api keeps none for
 * those routes. This catches what the first could still let through: a value
 * that happens to equal a decoded field, or a message this server did not
 * write. No length exemption: a one-character value is searched for too,
 * which can mangle the sentence and is the price of never showing it. The
 * JSON-escaped spelling is searched for as well, since data is shown as JSON.
 */
export function withoutValue(result: CallToolResult, value: string): CallToolResult {
  if (value === '') return result;
  const spellings = [...new Set([value, JSON.stringify(value).slice(1, -1)])].filter(Boolean);
  return {
    ...result,
    content: result.content.map((c) =>
      c.type === 'text'
        ? {
            ...c,
            text: spellings.reduce((t, v) => t.split(v).join('[secret value withheld]'), c.text),
          }
        : c,
    ),
  };
}

/** This server's own sentence for a store refusal, by status. Never the platform's. */
function storeAdvice(err: APIError, change: boolean): string {
  const unavailable = unavailableAdvice(err);
  if (unavailable) return unavailable;
  const status = statusAdvice(err.status, err.reason);
  if (status) return status;
  switch (err.status) {
    case 400:
      return 'the request was refused as invalid: a name or value outside the documented limits, a malformed id or revision_id, or the store\u2019s limit on secrets held or created (list_secrets reports both). Sending it again unchanged is refused the same way';
    case 404:
      return 'no such secret in this scope. A secret in a workspace is found only with its workspace_id; list_secrets says which exist';
    case 409:
      return change
        ? 'refused as a conflict and nothing changed: for a create, the name is taken in that scope; for a replace or delete, the revision_id is no longer the current one — get_secret for the current one, and send it again only if you still mean to'
        : 'refused as a conflict';
    case 429:
      return `too many requests${err.retryAfterMs === undefined ? '' : `; wait ${Math.ceil(err.retryAfterMs / 1000)}s`} before sending it again`;
    default:
      return change
        ? 'the platform did not complete this, and whether the change was made is not known. Read the secret back with list_secrets or get_secret before sending it again'
        : 'the platform did not answer this; it can be asked again shortly';
  }
}

/**
 * Run a secret-store tool, answering a failure only in this server's words.
 *
 * `failed` shows the platform's own sentence, which is right almost everywhere
 * and wrong here: a request that carried a value is the one whose refusal
 * could quote it back. So a refusal is reported as the status, the reason word
 * when it is a word, the request id, and a fixed sentence — and the result,
 * success or failure, goes through {@link withoutValue} as well.
 */
async function storeGuarded(
  what: string,
  change: boolean,
  value: string | undefined,
  fn: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  let result: CallToolResult;
  try {
    result = await fn();
  } catch (err) {
    if (err instanceof APIError) {
      // Exactly a documented word, and exactly a platform-minted id — and
      // neither if it shares four characters with the value sent. Nothing else
      // from the refusal is interpolated.
      const safe = (v: string) => value === undefined || !overlaps(v, value);
      const reason =
        err.reason !== undefined && DOCUMENTED_REASONS.has(err.reason) && safe(err.reason)
          ? `, reason "${err.reason}"`
          : '';
      const id =
        isRequestId(err.requestId) && safe(err.requestId) ? ` Request id ${err.requestId}.` : '';
      result = refused(
        `${what} was refused (HTTP ${err.status}${reason}): ${storeAdvice(err, change)}. The platform\u2019s own message is not shown, because a refusal of a secret-store request could quote the value.${id}`,
      );
    } else if (err instanceof MandalaError) {
      // Written by this package, and for these routes never carrying response
      // text: a transport failure, a cancellation, or a malformed answer.
      result = refused(`${what} failed: ${err.message}`);
    } else {
      result = refused(`${what} failed inside this server before an answer could be read.`);
    }
  }
  return value === undefined ? result : withoutValue(result, value);
}

export const registerSecrets: Registrar = (server, session) => {
  server.registerTool(
    'get_computer_secrets',
    {
      title: "Read a computer's secret bindings",
      description: `Which of the account's secrets a computer is bound to: for each, the secret id, the revision last delivered, and where the guest finds it — an environment variable name, or a file under ${FILES_DIR}. Values are NEVER shown — no value crosses this route. Also answers \`version\`, the number to send to set_computer_secrets so it changes only this list (0 for a computer never bound). Any role may read it. The list is what the computer receives at its next start or restart, which a running computer may not have yet. ${LIVE_VALUES}`,
      inputSchema: idArg,
      annotations: { readOnlyHint: true },
    },
    ({ computer_id }, extra) =>
      guarded(async () => {
        const id = session.resolve(computer_id);
        const body = await session.api
          .with(extra.signal)
          .json<unknown>('GET', P.computerAction(id, 'secrets'));
        const bindings = bindingsOf(body);
        if (!bindings) {
          return refused(
            `GET /computers/${id}/secrets answered with ${shapeOf(body)}, not a list of secret bindings. This does not mean the computer has none.`,
            body,
          );
        }
        if (!bindings.secrets.length) {
          return said(
            `${id} is bound to no secrets (version ${bindings.version}). set_computer_secrets binds some.`,
            body,
          );
        }
        const n = bindings.secrets.length;
        return said(
          `${id} is bound to ${n} secret${n === 1 ? '' : 's'} (version ${bindings.version}; ${LEGEND}):${listing(bindings)}`,
          body,
        );
      }),
  );

  server.registerTool(
    'set_computer_secrets',
    {
      title: "Replace a computer's secret bindings",
      description: `Replace the WHOLE list of secrets a computer is bound to — not a merge: any binding left out is removed, and \`secrets: []\` removes every binding. Each entry names a secret id and exactly one of \`env\` (the environment variable it is delivered under) or \`file\` (delivered as ${FILES_DIR}/<file>) — at most ${SECRET_BINDINGS_MAX} secrets, ${SECRET_FILES_MAX} of them as files, none twice and no variable or file name twice — and is recorded at that secret's latest revision unless it names \`revision_id\`, which must be the revision the computer holds now (any other revision is refused). A binding's revision is what the computer last received, never a pin: naming it only says this change keeps the value the running computer already has, so the change does not stop it being suspended. Only ids, revisions and names are sent and answered — values are NEVER shown or set here. ${TIMING} ${LIVE_VALUES} Binding a computer that has NO secrets yet requires it to be STOPPED: that first binding is refused with 409 while the computer is running or suspended, because a computer started without secrets cannot receive them until it starts again, and a restart does not do that. Start it afterwards to deliver them. Send \`version\` from get_computer_secrets to change only the list you read: if it changed since, this is refused with 409 and nothing changes. Also 409 while a delivery to the computer is in progress. After a change that drops a secret or moves one to another revision, a running computer cannot be suspended or memory-snapshotted until it restarts. Owners and members only; Linux computers only, and binding one for the first time needs a template whose image can receive secrets.`,
      inputSchema: {
        ...idArg,
        secrets: secretBindingsSchema(true).describe(
          'The complete new list. Every binding not in it is removed; [] removes them all.',
        ),
        version: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            'The `version` a read answered. Sent, the change is refused (409) if the list changed since; omitted, it replaces whatever is there.',
          ),
      },
      annotations: { destructiveHint: true },
    },
    ({ computer_id, secrets, version }, extra) =>
      guarded(async () => {
        const id = session.resolve(computer_id);
        const body = await session.api
          .with(extra.signal)
          .json<unknown>('PUT', P.computerAction(id, 'secrets'), {
            body: { secrets, ...(version === undefined ? {} : { version }) },
          });
        const bindings = bindingsOf(body);
        if (!bindings) {
          return refused(
            `PUT /computers/${id}/secrets answered with ${shapeOf(body)}, not a list of secret bindings. THE CHANGE MAY HAVE BEEN MADE — get_computer_secrets says what the computer is bound to now.`,
            body,
          );
        }
        const n = bindings.secrets.length;
        const what = n
          ? `${id} is now bound to ${n} secret${n === 1 ? '' : 's'} (version ${bindings.version}; ${LEGEND}):${listing(bindings)}`
          : `${id} is now bound to no secrets (version ${bindings.version}).`;
        return said(`${what}\n${TIMING} ${LIVE_VALUES}`, body);
      }),
  );
  // --- the store --------------------------------------------------------
  //
  // Which tools, and why (OPL-5026):
  //
  // - list_secrets and get_secret: yes. Names, ids and revisions are what a
  //   binding and every change need, and no value is ever in them.
  // - create_secret and replace_secret: yes. An agent that sets a computer up
  //   for a task is the caller that has the credential to put in, and the
  //   alternative is asking a person to paste it into Settings. The value is an
  //   argument and goes one way: no answer repeats it.
  // - delete_secret: yes, behind `confirm: true` and a description that says
  //   what it breaks — a computer still bound to a deleted secret cannot start —
  //   because cleaning up what a task created is part of the task.

  server.registerTool(
    'list_secrets',
    {
      title: "List the account's secrets",
      description:
        "The secrets stored on this account, in one scope: the account-wide ones by default, or one workspace's with workspace_id. For each: its name, its id (what set_computer_secrets binds), its current revision_id (what replace_secret and delete_secret need), its scope and when it was last delivered to a computer. Values are NEVER shown — no route returns one. Also says whether binding secrets to computers is switched on here, and the store's limits. Owners and members may read; a viewer is refused. An API key confined to a workspace lists that workspace's secrets, and naming another scope is refused.",
      inputSchema: {
        workspace_id: workspaceArg.describe(
          'The workspace to list. Leave it out for the account-wide secrets.',
        ),
      },
      annotations: { readOnlyHint: true },
    },
    ({ workspace_id }, extra) =>
      storeGuarded('Listing the secrets', false, undefined, async () => {
        const list: SecretList = await session.api
          .with(extra.signal)
          .secrets.list({ workspaceId: workspace_id });
        const scope = workspace_id === undefined ? 'account-wide' : `in workspace ${workspace_id}`;
        const delivery = list.delivery
          ? 'Binding secrets to computers is on.'
          : 'Binding secrets to computers is OFF on this platform: secrets can be stored, but set_computer_secrets and a create carrying secrets are refused.';
        const { limits } = list;
        const limitLine = `Limits: names up to ${limits.name_max_chars} characters, values up to ${limits.value_max_bytes} bytes; at most ${limits.active_per_account} secrets held at once across the account (deleting frees a place) and ${limits.created_per_account} created over its lifetime (deleting does not).`;
        const n = list.secrets.length;
        const head = n
          ? `${n} secret${n === 1 ? '' : 's'} ${scope} (${STORE_LEGEND}):\n${list.secrets.map(secretLine).join('\n')}`
          : `No secrets ${scope}. create_secret stores one.`;
        return said(`${head}\n${delivery} ${limitLine}`, list);
      }),
  );

  server.registerTool(
    'get_secret',
    {
      title: 'Read one secret',
      description:
        "One secret's name, scope, current revision_id and when it was last delivered — never its value. Read it for the current revision_id after replace_secret or delete_secret is refused because the revision moved. A secret in a workspace is found only with its workspace_id; otherwise it is not found.",
      inputSchema: { secret_id: secretIdArg, workspace_id: workspaceArg },
      annotations: { readOnlyHint: true },
    },
    ({ secret_id, workspace_id }, extra) =>
      storeGuarded(`Reading ${secret_id}`, false, undefined, async () => {
        const secret = await session.api
          .with(extra.signal)
          .secrets.get(secret_id, { workspaceId: workspace_id });
        return said(`${secretLine(secret)} (values are never shown)`, secret);
      }),
  );

  server.registerTool(
    'create_secret',
    {
      title: 'Store a new secret',
      description: `Store a value under a name on this account, encrypted, for binding to computers with set_computer_secrets (or the secrets field of a create). The value is sent once and NEVER shown again: this answer, every other tool and every route give back only the name, id and revision. Do not put the value anywhere else — not in a command line, a file or a message — when a binding can deliver it. Owners only. A name is unique within its scope (up to ${SECRET_NAME_MAX_CHARS} characters, no control characters); a taken name is refused with 409. The account holds at most 100 secrets at once and may create at most 1000 over its lifetime — list_secrets reports both. Without workspace_id the secret is account-wide and any computer on the account may be bound to it. NOT safe to repeat blind: if the answer is lost, list_secrets before creating again, since the secret may exist.`,
      inputSchema: {
        name: nameArg,
        value: valueArg('The value'),
        workspace_id: workspaceArg.describe(
          'The workspace it belongs to. Leave it out for an account-wide secret.',
        ),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    ({ name, value, workspace_id }, extra) =>
      storeGuarded('Storing the secret', true, value, async () => {
        const secret = await session.api
          .with(extra.signal)
          .secrets.create({ name, value, workspaceId: workspace_id });
        return said(
          `Stored ${secret.name} as ${secret.id}, revision ${secret.revision_id}, ${secret.workspace_id === null ? 'account-wide' : `in workspace ${secret.workspace_id}`}. The value is not shown and cannot be read back. Bind it to a computer with set_computer_secrets.`,
          secret,
        );
      }),
  );

  server.registerTool(
    'set_secret',
    {
      title: 'Store or replace a secret by name',
      description: `Make a name hold a value: create the secret if the scope has no secret by that name, or replace its value if it has — the one to reach for when either will do. It reads the scope first and replaces against the revision it read; names match ignoring ASCII case, as the platform keeps them unique. If the secret is created or replaced by someone else between the read and the write, it reads again and tries again, up to ${SECRET_SET_RETRIES} times. The value is NEVER shown back. Owners only. A new name counts against the account's limits on secrets held and created (list_secrets reports both). ${LIVE_VALUES} NOT safe to repeat blind when the answer is lost: list_secrets says whether the change landed.`,
      inputSchema: {
        name: nameArg,
        value: valueArg('The value'),
        workspace_id: workspaceArg.describe(
          'The scope to look in, and to create in. Leave it out for the account-wide secrets.',
        ),
      },
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    ({ name, value, workspace_id }, extra) =>
      storeGuarded(`Setting ${name.trim()}`, true, value, async () => {
        const store = session.api.with(extra.signal).secrets;
        for (let attempt = 0; ; attempt++) {
          const found = namedSecret(
            (await store.list({ workspaceId: workspace_id })).secrets,
            name,
          );
          try {
            const secret = found
              ? await store.replace(found.id, {
                  value,
                  revisionId: found.revision_id,
                  workspaceId: workspace_id,
                })
              : await store.create({ name: name.trim(), value, workspaceId: workspace_id });
            const scope =
              secret.workspace_id === null ? 'account-wide' : `in workspace ${secret.workspace_id}`;
            return said(
              found
                ? `Replaced the value of ${secret.name} (${secret.id}), ${scope}; it is now at revision ${secret.revision_id}. The value is not shown. Computers bound to it get it at their next start or restart, and a running one is sent it now on a best-effort basis.`
                : `Stored ${secret.name} as ${secret.id}, revision ${secret.revision_id}, ${scope}. The value is not shown and cannot be read back. Bind it to a computer with set_computer_secrets.`,
              { ...secret, created: !found },
            );
          } catch (err) {
            // A revision that moved, or a name somebody else just took: read again.
            if (!(err instanceof ConflictError) || attempt >= SECRET_SET_RETRIES) throw err;
          }
        }
      }),
  );

  server.registerTool(
    'replace_secret',
    {
      title: "Replace a secret's value",
      description: `Replace a stored secret's value, and move its revision_id. Send the revision_id list_secrets or get_secret answered: if it has moved since, this is refused with 409 and nothing changed — read it again, and replace again only if you still mean to. The new value is NEVER shown back. Owners only. ${LIVE_VALUES} That live send is asynchronous and best effort: this answer does not wait for it or say whether it landed, and a running computer may still hold the old value until its next start or restart, which always delivers the latest. get_computer's secrets_pending says whether one is still missing the change.`,
      inputSchema: {
        secret_id: secretIdArg,
        value: valueArg('The new value'),
        revision_id: revisionArg('A stale one is refused and nothing changes.'),
        workspace_id: workspaceArg,
      },
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    ({ secret_id, value, revision_id, workspace_id }, extra) =>
      storeGuarded(`Replacing the value of ${secret_id}`, true, value, async () => {
        const secret = await session.api.with(extra.signal).secrets.replace(secret_id, {
          value,
          revisionId: revision_id,
          workspaceId: workspace_id,
        });
        return said(
          `Replaced the value of ${secret.name} (${secret.id}); it is now at revision ${secret.revision_id}. The value is not shown. Computers bound to it get it at their next start or restart, and a running one is sent it now on a best-effort basis.`,
          secret,
        );
      }),
  );

  server.registerTool(
    'delete_secret',
    {
      title: 'Delete a secret',
      description:
        "Permanently delete a stored secret. This cannot be undone, and it is NOT refused while computers are bound to it: such a computer keeps the value it already holds, but can never be given its secrets again — its next start is refused (409), a restart or a reboot inside it stops it, and a suspended one cannot resume. Remove the binding with set_computer_secrets first (or on the stopped computer afterwards) so it can start. Deleting does not recall a value already delivered. Needs the current revision_id (a stale one is refused and nothing is deleted) and confirm: true. Owners only. Deleting frees a place under the account's limit on secrets held at once, but not under its lifetime limit on secrets created.",
      inputSchema: {
        secret_id: secretIdArg,
        revision_id: revisionArg('Required; a stale one is refused and nothing is deleted.'),
        workspace_id: workspaceArg,
        confirm: z
          .literal(true)
          .describe(
            'Must be true. A computer still bound to this secret cannot start again until that binding is removed.',
          ),
      },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    ({ secret_id, revision_id, workspace_id }, extra) =>
      storeGuarded(`Deleting ${secret_id}`, true, undefined, async () => {
        try {
          await session.api
            .with(extra.signal)
            .secrets.delete(secret_id, { revisionId: revision_id, workspaceId: workspace_id });
        } catch (err) {
          if (!(err instanceof NotFoundError)) throw err;
          return refused(
            `Nothing was deleted: no secret ${secret_id} was found${workspace_id === undefined ? ' among the account-wide secrets' : ` in workspace ${workspace_id}`}. Either it was already deleted, or it is in a scope this did not name — list_secrets says which.`,
          );
        }
        return said(
          `Deleted ${secret_id}. Any computer still bound to it cannot start again until set_computer_secrets removes that binding.`,
        );
      }),
  );
};
