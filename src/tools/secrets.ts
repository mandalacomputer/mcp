import { z } from 'zod';
import { guarded, refused, said } from '../format.js';
import * as P from '../paths.js';
import type { Registrar } from './types.js';

/**
 * A computer's secret bindings: which of the account's secrets it receives, at
 * which revision, and where — as an environment variable (`env`) or as a file
 * under FILES_DIR (`file`).
 *
 * No value ever crosses these routes, in either direction — only secret ids,
 * revision ids, env names and file names — so nothing here can show one, and
 * nothing a model sends can set one. Secrets themselves are created and rotated
 * elsewhere.
 *
 * A change of bindings takes effect at the computer's NEXT START OR RESTART. A
 * running computer keeps what it booted with until then, and a suspended one
 * resumes with its old values; the sentences below say so every time, because a
 * model that reads "saved" as "delivered" goes on to use a credential the guest
 * does not have yet. The one thing that reaches a running computer sooner is a
 * replaced VALUE of a secret bound as a file: that file is rewritten in place.
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

/** What reaches a running computer without a restart: a replaced value, as a file. */
const LIVE_FILES =
  "Every start and restart delivers each secret's latest value. Separately, when a secret's value is replaced, a running computer bound to it as a file has that file rewritten within seconds; a variable waits for the next start or restart.";

export const registerSecrets: Registrar = (server, session) => {
  server.registerTool(
    'get_computer_secrets',
    {
      title: "Read a computer's secret bindings",
      description: `Which of the account's secrets a computer is bound to: for each, the secret id, the revision last delivered, and where the guest finds it — an environment variable name, or a file under ${FILES_DIR}. Values are NEVER shown — no value crosses this route. Also answers \`version\`, the number to send to set_computer_secrets so it changes only this list (0 for a computer never bound). Any role may read it. The list is what the computer receives at its next start or restart, which a running computer may not have yet. ${LIVE_FILES}`,
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
      description: `Replace the WHOLE list of secrets a computer is bound to — not a merge: any binding left out is removed, and \`secrets: []\` removes every binding. Each entry names a secret id and exactly one of \`env\` (the environment variable it is delivered under) or \`file\` (delivered as ${FILES_DIR}/<file>) — at most ${SECRET_BINDINGS_MAX} secrets, ${SECRET_FILES_MAX} of them as files, none twice and no variable or file name twice — and is recorded at that secret's latest revision unless it names \`revision_id\`, which must be the revision the computer holds now (any other revision is refused). A binding's revision is what the computer last received, never a pin: naming it only says this change keeps the value the running computer already has, so the change does not stop it being suspended. Only ids, revisions and names are sent and answered — values are NEVER shown or set here. ${TIMING} ${LIVE_FILES} Binding a computer that has NO secrets yet requires it to be STOPPED: that first binding is refused with 409 while the computer is running or suspended, because a computer started without secrets cannot receive them until it starts again, and a restart does not do that. Start it afterwards to deliver them. Send \`version\` from get_computer_secrets to change only the list you read: if it changed since, this is refused with 409 and nothing changes. Also 409 while a delivery to the computer is in progress. After a change that drops a secret or moves one to another revision, a running computer cannot be suspended or memory-snapshotted until it restarts. Owners and members only; Linux computers only, and binding one for the first time needs a template whose image can receive secrets.`,
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
        return said(`${what}\n${TIMING} ${LIVE_FILES}`, body);
      }),
  );
};
