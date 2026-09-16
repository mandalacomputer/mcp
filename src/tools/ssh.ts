import { z } from 'zod';
import { NotFoundError } from '../errors.js';
import { guarded, refused, said } from '../format.js';
import * as P from '../paths.js';
import type { Registrar } from './types.js';

/**
 * SSH access: the caller's public keys, and whether SSH is on for a computer.
 *
 * Keys belong to the PERSON the API key was issued to, not to the account: one
 * key identifies one person, the same list comes back whichever account the
 * key acts on, and a key added here is accepted by every SSH-on computer of
 * every account where that person is an owner or member. Viewers cannot
 * connect. A workspace-scoped API key may read keys but not add or remove them.
 *
 * The connection itself is ordinary OpenSSH through the platform's jump host,
 * which a model cannot open from here; these tools set it up and report on it.
 */

const idArg = {
  computer_id: z
    .string()
    .optional()
    .describe('Which computer. Defaults to the one selected with use_computer.'),
};

const keyIdArg = {
  key_id: z.string().describe('The key id — `sshk-` and sixteen hex characters.'),
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const shapeOf = (v: unknown): string =>
  v === undefined ? 'no body at all' : v === null ? 'null' : Array.isArray(v) ? 'a list' : typeof v;

const text = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** One key in a line: what a person recognises it by. */
const keyLine = (k: Record<string, unknown>): string =>
  `${text(k.id) ?? '?'}  ${text(k.key_type) ?? '?'}  ${text(k.fingerprint) ?? '?'}  ${text(k.name) ?? ''}`.trimEnd();

/** The setting of one computer, checked: every field the sentence reads, or nothing. */
type Setting = {
  computer: string;
  enabled: boolean;
  available: boolean | null;
  pending: boolean;
  key_count: number;
  /** Why the hypervisor refused the current setting, when it did. */
  error: string | null;
};

function settingOf(body: unknown): Setting | undefined {
  if (!isRecord(body)) return undefined;
  const { computer, enabled, available, pending, key_count } = body;
  if (typeof computer !== 'string' || typeof enabled !== 'boolean' || typeof pending !== 'boolean')
    return undefined;
  if (available !== null && typeof available !== 'boolean') return undefined;
  if (typeof key_count !== 'number' || !Number.isSafeInteger(key_count) || key_count < 0)
    return undefined;
  // Optional, so an answer from before the field existed still reads; anything
  // other than a string or null is not an answer this can describe.
  const error = body.error ?? null;
  if (error !== null && typeof error !== 'string') return undefined;
  return { computer, enabled, available, pending, key_count, error };
}

/** The sentence in front of a setting: whether SSH will work, and if not, why. */
function settingLine(s: Setting): string {
  const state = s.enabled ? 'SSH is ON' : 'SSH is off';
  if (s.error) {
    return `${state} for ${s.computer}, but its hypervisor REFUSED this setting, so the computer does not have it: ${s.error}`;
  }
  if (s.enabled && s.available === false) {
    return `${state} for ${s.computer}, but this computer CANNOT RUN SSH: it was made from a template image that predates SSH. Create a new computer from the current template to use SSH.`;
  }
  const delivery = s.pending
    ? ' Its hypervisor has not received this setting yet; it is sent again automatically, and before any connection.'
    : '';
  if (!s.enabled) return `${state} for ${s.computer}.${delivery}`;
  const keys =
    s.key_count === 0
      ? 'No keys can log in yet — add one with add_ssh_key.'
      : `${s.key_count} key${s.key_count === 1 ? '' : 's'} (every owner's and member's) can log in.`;
  const unknown =
    s.available === null
      ? ' Whether the computer can run SSH is not known until it next starts.'
      : '';
  return `${state} for ${s.computer}. ${keys}${unknown}${delivery}`;
}

export const registerSSH: Registrar = (server, session) => {
  server.registerTool(
    'list_ssh_keys',
    {
      title: 'List your SSH keys',
      description:
        'The SSH public keys registered to the person this API key belongs to — the same list whichever account the key acts on. Each is accepted by every computer with SSH on, on every account where that person is an owner or member. Shows id, type, SHA256 fingerprint and name.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    (_args, extra) =>
      guarded(async () => {
        const body = await session.api.with(extra.signal).json<unknown>('GET', P.SSH_KEYS);
        if (!Array.isArray(body)) {
          return refused(
            `GET /ssh-keys answered with ${shapeOf(body)}, not a list of keys. This does not mean you have none.`,
            body,
          );
        }
        const rows = body.filter(isRecord);
        if (rows.length !== body.length) {
          return refused(
            `GET /ssh-keys answered with ${body.length - rows.length} malformed entr${body.length - rows.length === 1 ? 'y' : 'ies'}; the list cannot be trusted.`,
            body,
          );
        }
        if (!rows.length)
          return said('No SSH keys are registered to you. add_ssh_key adds one.', body);
        return said(
          `${rows.length} SSH key${rows.length === 1 ? '' : 's'}, oldest first:\n${rows.map(keyLine).join('\n')}`,
          body,
        );
      }),
  );

  server.registerTool(
    'add_ssh_key',
    {
      title: 'Add an SSH public key',
      description:
        'Register an OpenSSH public key to the person this API key belongs to. Accepted: Ed25519, ECDSA (P-256, P-384, P-521), their security-key forms, and RSA of at least 3072 bits. Refused: DSA, shorter RSA, certificates, a line with SSH options in front of the key, and anything but one key on one line. A key can belong to one person only, and each person may hold eight. Never send a PRIVATE key.',
      inputSchema: {
        public_key: z
          .string()
          .describe(
            'One line from a .pub file: "<type> <base64> [comment]". The comment is dropped.',
          ),
        name: z
          .string()
          .optional()
          .describe('A label, up to 60 characters. Defaults to the comment on the line.'),
      },
    },
    ({ public_key, name }, extra) =>
      guarded(async () => {
        if (/PRIVATE KEY/.test(public_key)) {
          return refused(
            'That is a private key. Nothing was sent. Send the contents of the matching .pub file instead, and treat the private key as exposed.',
          );
        }
        const body = await session.api.with(extra.signal).json<unknown>('POST', P.SSH_KEYS, {
          body: { public_key, ...(name === undefined ? {} : { name }) },
        });
        if (!isRecord(body) || !text(body.id)) {
          return refused(
            `POST /ssh-keys answered with ${shapeOf(body)} and no key id. THE KEY MAY HAVE BEEN ADDED — call list_ssh_keys before adding it again.`,
            body,
          );
        }
        return said(
          `Added ${keyLine(body)}. Computers with SSH on accept it within moments.`,
          body,
        );
      }),
  );

  server.registerTool(
    'remove_ssh_key',
    {
      title: 'Remove an SSH public key',
      description:
        'Remove one of your SSH keys. New connections with it are refused at once, and it is removed from the computers it was written into within moments; a session already open goes on until it disconnects.',
      inputSchema: {
        ...keyIdArg,
        confirm: z.literal(true).describe('Must be true. This stops the key opening connections.'),
      },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    ({ key_id }, extra) =>
      guarded(async () => {
        let res: unknown;
        try {
          res = await session.api.with(extra.signal).send('DELETE', P.sshKey(key_id));
        } catch (err) {
          if (!(err instanceof NotFoundError)) throw err;
          return said(
            `Nothing was removed: you have no SSH key with the id ${key_id}. Either it was already removed, or the id is wrong and a key you meant may still be registered — list_ssh_keys says which.`,
          );
        }
        return said(`Removed ${key_id}. It can no longer open connections.`, res);
      }),
  );

  server.registerTool(
    'get_computer_ssh',
    {
      title: 'Read whether SSH is on for a computer',
      description:
        'Whether SSH is switched on for a computer, whether that computer can run SSH at all (one made from an older template image cannot), how many keys can log in, and whether its hypervisor has the current setting yet. Any role may read it.',
      inputSchema: idArg,
      annotations: { readOnlyHint: true },
    },
    ({ computer_id }, extra) =>
      guarded(async () => {
        const id = session.resolve(computer_id);
        const body = await session.api
          .with(extra.signal)
          .json<unknown>('GET', P.computerAction(id, 'ssh'));
        const setting = settingOf(body);
        if (!setting) {
          return refused(
            `GET /computers/${id}/ssh answered with ${shapeOf(body)}, not an SSH setting. Whether SSH is on is unknown.`,
            body,
          );
        }
        return said(settingLine(setting), body);
      }),
  );

  server.registerTool(
    'set_computer_ssh',
    {
      title: 'Switch SSH on or off for a computer',
      description:
        'Turn SSH on or off for a computer. On, the computer runs an SSH server reachable only through the platform jump host, accepting the keys of every owner and member of the account; off, the server stops and open SSH sessions are closed. No restart either way. Owners and members only.',
      inputSchema: {
        ...idArg,
        enabled: z.boolean().describe('true to switch SSH on, false to switch it off.'),
      },
      annotations: { idempotentHint: true },
    },
    ({ computer_id, enabled }, extra) =>
      guarded(async () => {
        const id = session.resolve(computer_id);
        const body = await session.api
          .with(extra.signal)
          .json<unknown>('PUT', P.computerAction(id, 'ssh'), { body: { enabled } });
        const setting = settingOf(body);
        if (!setting) {
          return refused(
            `PUT /computers/${id}/ssh answered with ${shapeOf(body)}, not an SSH setting. THE CHANGE MAY HAVE BEEN MADE — get_computer_ssh says whether it was.`,
            body,
          );
        }
        if (setting.enabled !== enabled) {
          return refused(
            `Asked to switch SSH ${enabled ? 'on' : 'off'}, and the platform answered that it is ${setting.enabled ? 'on' : 'off'}. Nothing here assumes which is true — call get_computer_ssh.`,
            body,
          );
        }
        return said(settingLine(setting), body);
      }),
  );
};
