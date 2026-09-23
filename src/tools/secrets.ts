import { z } from 'zod';
import { guarded, refused, said } from '../format.js';
import * as P from '../paths.js';
import type { Registrar } from './types.js';

/**
 * A computer's secret bindings: which of the account's secrets it receives, at
 * which revision, and under which environment variable name.
 *
 * No value ever crosses these routes, in either direction — only secret ids,
 * revision ids and env names — so nothing here can show one, and nothing a
 * model sends can set one. Secrets themselves are created and rotated elsewhere.
 *
 * A change takes effect at the computer's NEXT START OR RESTART. A running
 * computer keeps the environment it booted with until then, and a suspended one
 * resumes with its old values; the sentences below say so every time, because a
 * model that reads "saved" as "delivered" goes on to use a credential the guest
 * does not have yet.
 */

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

type Binding = { secret_id: string; revision_id: string; env: string };

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
    const { secret_id, revision_id, env } = entry;
    if (typeof secret_id !== 'string' || !secret_id) return undefined;
    if (typeof revision_id !== 'string' || !revision_id) return undefined;
    if (typeof env !== 'string' || !env) return undefined;
    out.push({ secret_id, revision_id, env });
  }
  return { secrets: out, version };
}

/** One binding in a line: the name the guest sees, then what it is bound to. */
const bindingLine = (b: Binding): string => `${b.env} = ${b.secret_id} @ ${b.revision_id}`;

function listing(b: Bindings): string {
  if (!b.secrets.length) return 'none';
  return `\n${b.secrets.map(bindingLine).join('\n')}`;
}

const TIMING =
  'The new values reach the guest at its NEXT START OR RESTART: a running computer keeps its old environment until then, and a suspended one resumes with its old values.';

export const registerSecrets: Registrar = (server, session) => {
  server.registerTool(
    'get_computer_secrets',
    {
      title: "Read a computer's secret bindings",
      description:
        "Which of the account's secrets a computer is bound to: for each, the secret id, the revision it is pinned at, and the environment variable name it is delivered under. Values are NEVER shown — no value crosses this route. Also answers `version`, the number to send to set_computer_secrets so it changes only this list (0 for a computer never bound). Any role may read it. The list is what the computer receives at its next start or restart, which a running computer may not have yet.",
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
          `${id} is bound to ${n} secret${n === 1 ? '' : 's'} (version ${bindings.version}; env = secret @ revision, values never shown):${listing(bindings)}`,
          body,
        );
      }),
  );

  server.registerTool(
    'set_computer_secrets',
    {
      title: "Replace a computer's secret bindings",
      description: `Replace the WHOLE list of secrets a computer is bound to — not a merge: any binding left out is removed, and \`secrets: []\` removes every binding. Each entry names a secret id and the environment variable it is delivered under, and is pinned at that secret's LATEST revision unless it names \`revision_id\`, which must be the revision the computer is bound to now (to keep that pin; any other revision is refused). Only ids, revisions and env names are sent and answered — values are NEVER shown or set here. ${TIMING} Binding a computer that has NO secrets yet requires it to be STOPPED: that first binding is refused with 409 while the computer is running or suspended, because a computer started without secrets cannot receive them until it starts again, and a restart does not do that. Start it afterwards to deliver them. Send \`version\` from get_computer_secrets to change only the list you read: if it changed since, this is refused with 409 and nothing changes. Also 409 while a delivery to the computer is in progress. After a change that drops a secret or moves one to another revision, a running computer cannot be suspended or memory-snapshotted until it restarts. Owners and members only; Linux computers only, and binding one for the first time needs a template whose image can receive secrets.`,
      inputSchema: {
        ...idArg,
        secrets: z
          .array(
            z.object({
              secret_id: z.string().describe('The secret to bind — `csec-` and sixteen hex.'),
              env: z
                .string()
                .describe(
                  'The environment variable name the guest receives it under: letters, digits and underscores, not starting with a digit.',
                ),
              revision_id: z
                .string()
                .optional()
                .describe(
                  'Omit to bind the latest revision. Name one only to keep the revision the computer is bound to now.',
                ),
            }),
          )
          .describe(
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
          ? `${id} is now bound to ${n} secret${n === 1 ? '' : 's'} (version ${bindings.version}; env = secret @ revision, values never shown):${listing(bindings)}`
          : `${id} is now bound to no secrets (version ${bindings.version}).`;
        return said(`${what}\n${TIMING}`, body);
      }),
  );
};
