import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connect, installFakePlatform, SECRET_BINDINGS } from './harness.js';

// The secret-binding tools: what a computer is bound to, and replacing that
// list. What is pinned is the request sent, the sentence a model acts on —
// including WHEN a change reaches the guest — and the refusals that stop it
// acting on a body this server could not read.

const textOf = (res: CallToolResult) =>
  res.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

const BOUND = SECRET_BINDINGS.secrets[0];
const AS_FILE = SECRET_BINDINGS.secrets[1];
const A = 'csec-0123456789abcdef';
const B = 'csec-0123456789abcde0';

/**
 * A call the tool's schema should refuse: an error, and nothing sent. Whether
 * the SDK answers a schema failure as an error result or a thrown protocol
 * error is its business; either way the platform must not have been asked.
 */
async function refusedBeforeSending(
  platform: { calls: { method: string; path: string }[] },
  call: (name: string, args: Record<string, unknown>) => Promise<CallToolResult>,
  tool: string,
  args: Record<string, unknown>,
  name: string,
) {
  const before = platform.calls.length;
  let res: CallToolResult | undefined;
  try {
    res = await call(tool, args);
  } catch {
    res = undefined;
  }
  if (res) expect(res.isError, name).toBe(true);
  expect(platform.calls.slice(before), name).toEqual([]);
}

/** Nine file bindings: one over the cap of eight. */
const NINE_FILES = Array.from({ length: 9 }, (_, i) => ({
  secret_id: `csec-${String(i).repeat(16)}`,
  file: `f${i}`,
}));

const BAD_LISTS: [string, unknown[]][] = [
  ['both', [{ secret_id: A, env: 'X', file: 'x' }]],
  ['neither', [{ secret_id: A }]],
  ['a bad variable', [{ secret_id: A, env: '1X' }]],
  ['a variable too long', [{ secret_id: A, env: `X${'Y'.repeat(64)}` }]],
  ['a bad file name', [{ secret_id: A, file: 'Ca.pem' }]],
  ['a file name with a slash', [{ secret_id: A, file: '../etc' }]],
  ['a file name too long', [{ secret_id: A, file: `f${'x'.repeat(48)}` }]],
  ['an empty secret id', [{ secret_id: '', env: 'X' }]],
  ['a blank secret id', [{ secret_id: '   ', env: 'X' }]],
  ['a secret id with a space before it', [{ secret_id: ` ${A}`, env: 'X' }]],
  ['a secret id with a space after it', [{ secret_id: `${A} `, env: 'X' }]],
  [
    'one secret twice',
    [
      { secret_id: A, env: 'X' },
      { secret_id: A, env: 'Y' },
    ],
  ],
  [
    'one variable twice',
    [
      { secret_id: A, env: 'X' },
      { secret_id: B, env: 'X' },
    ],
  ],
  [
    'one file twice',
    [
      { secret_id: A, file: 'x' },
      { secret_id: B, file: 'x' },
    ],
  ],
  ['nine files', NINE_FILES],
  [
    'thirty-three secrets',
    Array.from({ length: 33 }, (_, i) => ({
      secret_id: `csec-${i.toString(16).padStart(16, '0')}`,
      env: `V${i}`,
    })),
  ],
];

describe('the secret-binding tools', () => {
  let platform: ReturnType<typeof installFakePlatform>;
  beforeEach(() => {
    platform = installFakePlatform();
  });
  afterEach(() => platform.restore());

  it('reads one computer’s bindings by variable or file, secret and revision', async () => {
    const { call, close } = await connect();
    const res = await call('get_computer_secrets', { computer_id: 'vm-7' });
    expect(res.isError).toBeFalsy();
    const text = textOf(res);
    expect(text).toContain('vm-7 is bound to 2 secrets (version 3');
    expect(text).toContain(`${BOUND.env} = ${BOUND.secret_id} @ ${BOUND.revision_id}`);
    // A file binding says where the guest finds it: the full path.
    expect(text).toContain(
      `/run/mandala-secrets/user/files/${AS_FILE.file} = ${AS_FILE.secret_id} @ ${AS_FILE.revision_id}`,
    );
    expect(text).not.toContain('undefined');
    expect(platform.calls.at(-1)).toMatchObject({
      method: 'GET',
      path: '/computers/vm-7/secrets',
    });
    await close();
  });

  it('sends the list as given, and the version only when there is one', async () => {
    const { call, close } = await connect();
    const keep = { ...BOUND };
    const fresh = { secret_id: 'csec-fedcba9876543210', env: 'GITHUB_TOKEN' };
    const first = await call('set_computer_secrets', {
      computer_id: 'vm-7',
      secrets: [keep, fresh],
    });
    expect(first.isError).toBeFalsy();
    await call('set_computer_secrets', { computer_id: 'vm-7', secrets: [], version: 3 });
    // 0 is what a never-bound computer reads back, and it is a condition, not
    // an absence: sent, so the change lands only on a list still never bound.
    await call('set_computer_secrets', { computer_id: 'vm-7', secrets: [fresh], version: 0 });
    const puts = platform.calls.filter((c) => c.method === 'PUT');
    expect(puts.map((c) => [c.path, c.body])).toEqual([
      ['/computers/vm-7/secrets', { secrets: [keep, fresh] }],
      ['/computers/vm-7/secrets', { secrets: [], version: 3 }],
      ['/computers/vm-7/secrets', { secrets: [fresh], version: 0 }],
    ]);
    expect(puts[0].body).not.toHaveProperty('version');
    await close();
  });

  it('sends file bindings and a kept revision whole, and reads the echo back', async () => {
    const { call, close } = await connect();
    const keep = { secret_id: A, env: 'API_TOKEN', revision_id: 'csr-0123456789abcdef01234567' };
    const asFile = { secret_id: B, file: 'kubeconfig' };
    const res = await call('set_computer_secrets', {
      computer_id: 'vm-7',
      secrets: [keep, asFile],
      version: 3,
    });
    expect(res.isError).toBeFalsy();
    expect(platform.calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([
      { secrets: [keep, asFile], version: 3 },
    ]);
    // The fake platform answers what it was sent, so this reads the PUT's own
    // decode of a file binding, not a fixture.
    const text = textOf(res);
    expect(text).toContain('vm-7 is now bound to 2 secrets (version 4');
    expect(text).toContain(`API_TOKEN = ${A} @ csr-0123456789abcdef01234567`);
    expect(text).toContain(
      `/run/mandala-secrets/user/files/kubeconfig = ${B} @ csr-latest000000000000000000`,
    );
    await close();
  });

  it('lets a variable and a file share a spelling', async () => {
    const { call, close } = await connect();
    const secrets = [
      { secret_id: A, env: 'ca' },
      { secret_id: B, file: 'ca' },
    ];
    expect((await call('set_computer_secrets', { secrets })).isError).toBeFalsy();
    expect(platform.calls.filter((c) => c.method === 'PUT').at(-1)?.body).toEqual({ secrets });
    await close();
  });

  it('refuses before sending a list the platform would refuse', async () => {
    const { call, close } = await connect();
    for (const [name, secrets] of [
      ...BAD_LISTS,
      ['an empty revision', [{ secret_id: A, env: 'X', revision_id: '' }]],
      ['a blank revision', [{ secret_id: A, env: 'X', revision_id: ' ' }]],
      ['a padded revision', [{ secret_id: A, env: 'X', revision_id: 'csr-x ' }]],
    ] as [string, unknown[]][]) {
      await refusedBeforeSending(platform, call, 'set_computer_secrets', { secrets }, name);
    }
    await close();
  });

  it('answers what the computer is now bound to, and when the guest gets it', async () => {
    const { call, close } = await connect();
    const set = textOf(
      await call('set_computer_secrets', {
        computer_id: 'vm-7',
        secrets: [{ secret_id: 'csec-fedcba9876543210', env: 'GITHUB_TOKEN' }],
      }),
    );
    expect(set).toContain('vm-7 is now bound to 1 secret (version 4');
    expect(set).toContain('GITHUB_TOKEN = csec-fedcba9876543210 @ csr-latest');
    expect(set).toContain('NEXT START OR RESTART');
    const cleared = textOf(
      await call('set_computer_secrets', { computer_id: 'vm-7', secrets: [] }),
    );
    expect(cleared).toMatch(/^vm-7 is now bound to no secrets \(version 4\)\./);
    expect(cleared).toContain('NEXT START OR RESTART');
    await close();
  });

  it('says in the description that the list is replaced and values are never shown', async () => {
    const { client, close } = await connect();
    const { tools } = await client.listTools();
    const set = tools.find((t) => t.name === 'set_computer_secrets');
    const get = tools.find((t) => t.name === 'get_computer_secrets');
    expect(set?.description).toContain('WHOLE list');
    expect(set?.description).toContain('`secrets: []` removes every binding');
    expect(set?.description).toContain('NEXT START OR RESTART');
    expect(set?.description).toContain('409');
    expect(set?.description).toContain(
      'Binding a computer that has NO secrets yet requires it to be STOPPED',
    );
    expect(set?.description).toContain('running or suspended');
    expect(set?.description).toContain('Start it afterwards to deliver them');
    expect(set?.description).toContain('NEVER shown');
    expect(set?.annotations?.readOnlyHint).not.toBe(true);
    expect(set?.annotations?.destructiveHint).toBe(true);
    expect(get?.description).toContain('NEVER shown');
    expect(get?.annotations?.readOnlyHint).toBe(true);
    // Files: where they land, and the one change that reaches a running guest.
    for (const d of [set?.description, get?.description]) {
      expect(d).toContain('/run/mandala-secrets/user/files');
      expect(d).toContain('rewritten within seconds');
    }
    expect(set?.description).toContain('exactly one of `env`');
    expect(set?.description).toContain('at most 32 secrets, 8 of them as files');
    await close();
  });
});

describe('the secret-binding tools over answers they cannot trust', () => {
  const over = async (
    body: unknown,
    status: number,
    tool: string,
    args: Record<string, unknown>,
  ) => {
    const restore = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
    try {
      const { call, close } = await connect();
      const res = await call(tool, args);
      await close();
      return res;
    } finally {
      globalThis.fetch = restore;
    }
  };

  it('surfaces a 409 with the platform’s own sentence', async () => {
    const error =
      'The secrets on this computer were changed since you read them. Read them again and save your change.';
    const res = await over({ error }, 409, 'set_computer_secrets', {
      computer_id: 'vm-1',
      secrets: [],
      version: 2,
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain(error);
    expect(textOf(res)).toContain('409');
    expect(textOf(res)).not.toContain('now bound');
  });

  it('reads a computer never bound as none, at version 0', async () => {
    const res = await over({ secrets: [], version: 0 }, 200, 'get_computer_secrets', {
      computer_id: 'vm-1',
    });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain('vm-1 is bound to no secrets (version 0)');
  });

  // Every answer below is one neither tool may render as a binding list: a
  // short or guessed list lets the next set drop a binding nobody saw.
  const UNREADABLE: unknown[] = [
    {},
    { secrets: [] },
    { secrets: 'none', version: 1 },
    { secrets: [null], version: 1 },
    { secrets: [{ ...BOUND, revision_id: 7 }], version: 1 },
    { secrets: [], version: -1 },
    // No version at all: never read as 0.
    { secrets: [BOUND] },
    { secrets: [BOUND], version: '3' },
    { secrets: [BOUND], version: 1.5 },
    // A row with no id, an empty one, or no revision: the list is refused
    // whole rather than shown one short, which would let a set drop a
    // binding the caller never saw.
    { secrets: [BOUND, { revision_id: 'csr-x', env: 'X' }], version: 1 },
    { secrets: [BOUND, { secret_id: '', revision_id: 'csr-x', env: 'X' }], version: 1 },
    { secrets: [BOUND, { secret_id: B, env: 'X' }], version: 1 },
    { secrets: [BOUND, { secret_id: B, revision_id: ' ', env: 'X' }], version: 1 },
    // Both of env and file, or neither, or a file that is not a string.
    { secrets: [{ ...AS_FILE, env: 'X' }], version: 1 },
    { secrets: [{ secret_id: B, revision_id: 'csr-x' }], version: 1 },
    { secrets: [{ secret_id: B, revision_id: 'csr-x', file: 7 }], version: 1 },
    { secrets: [{ secret_id: B, revision_id: 'csr-x', file: '' }], version: 1 },
    // A name the platform would never have accepted, and an empty variable
    // beside a file — both, not a file with the variable normalised away.
    { secrets: [{ ...BOUND, env: '1X' }], version: 1 },
    { secrets: [{ ...AS_FILE, file: 'Ca.pem' }], version: 1 },
    { secrets: [{ ...AS_FILE, file: '../x' }], version: 1 },
    { secrets: [{ ...AS_FILE, env: '' }], version: 1 },
    // Ids with space around them are not the ids the platform holds.
    { secrets: [{ ...BOUND, secret_id: ` ${BOUND.secret_id}` }], version: 1 },
    { secrets: [{ ...BOUND, revision_id: `${BOUND.revision_id} ` }], version: 1 },
  ];

  it('does not call an unreadable listing an empty one', async () => {
    for (const body of UNREADABLE) {
      const res = await over(body, 200, 'get_computer_secrets', { computer_id: 'vm-1' });
      expect(res.isError, JSON.stringify(body)).toBe(true);
      expect(textOf(res)).toContain('This does not mean the computer has none');
    }
  });

  it('does not report an unreadable answer to a set as the new list', async () => {
    for (const body of UNREADABLE) {
      const res = await over(body, 200, 'set_computer_secrets', {
        computer_id: 'vm-1',
        secrets: [],
      });
      expect(res.isError, JSON.stringify(body)).toBe(true);
      expect(textOf(res)).toContain('THE CHANGE MAY HAVE BEEN MADE');
      expect(textOf(res)).not.toContain('now bound');
    }
  });

  it('reads a null variable or file as absent, not as a second name', async () => {
    const res = await over(
      {
        secrets: [
          { ...AS_FILE, env: null },
          { ...BOUND, file: null },
        ],
        version: 2,
      },
      200,
      'get_computer_secrets',
      { computer_id: 'vm-1' },
    );
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain('vm-1 is bound to 2 secrets (version 2');
    expect(textOf(res)).toContain(`/run/mandala-secrets/user/files/${AS_FILE.file} =`);
  });

  it('says a change may have been made when the answer cannot be read', async () => {
    const res = await over({ ok: true }, 200, 'set_computer_secrets', {
      computer_id: 'vm-1',
      secrets: [],
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('THE CHANGE MAY HAVE BEEN MADE');
  });
});

describe('binding secrets at create', () => {
  let platform: ReturnType<typeof installFakePlatform>;
  beforeEach(() => {
    platform = installFakePlatform();
  });
  afterEach(() => platform.restore());

  const creates = () =>
    platform.calls.filter((c) => c.method === 'POST' && c.path === '/computers');

  it('sends each binding in the wire spelling, as a variable or as a file', async () => {
    const { call, close } = await connect();
    const secrets = [
      { secret_id: A, env: 'API_TOKEN' },
      { secret_id: B, file: 'kubeconfig' },
    ];
    const res = await call('create_computer', { template: 'base', secrets });
    expect(res.isError).toBeFalsy();
    // The whole body, not a subset: nothing else added, nothing renamed.
    expect(creates().map((c) => c.body)).toEqual([{ template: 'base', secrets, start: true }]);
    await close();
  });

  it('sends no secrets key at all when none are bound', async () => {
    const { call, close } = await connect();
    await call('create_computer', { template: 'base' });
    expect(creates()).toHaveLength(1);
    expect(creates()[0].body).not.toHaveProperty('secrets');
    await close();
  });

  it('refuses before sending what the platform would refuse', async () => {
    const { call, close } = await connect();
    for (const [name, secrets] of [
      ...BAD_LISTS,
      // A create has no revision to keep: refused, not dropped.
      [
        'a revision on a create',
        [{ secret_id: 'csec-0123456789abcdef', env: 'X', revision_id: 'csr-1' }],
      ],
      ['an unknown key', [{ secret_id: 'csec-0123456789abcdef', env: 'X', revision: 'csr-1' }]],
    ] as [string, unknown[]][]) {
      await refusedBeforeSending(
        platform,
        call,
        'create_computer',
        { template: 'base', secrets },
        name,
      );
    }
    // Eight files is the cap, not over it.
    const eight = NINE_FILES.slice(0, 8);
    expect(
      (await call('create_computer', { template: 'base', secrets: eight })).isError,
    ).toBeFalsy();
    expect(creates().map((c) => (c.body as Record<string, unknown>).secrets)).toEqual([eight]);
    await close();
  });

  it('describes the parameter: variable or file, never a value', async () => {
    const { client, close } = await connect();
    const create = (await client.listTools()).tools.find((t) => t.name === 'create_computer');
    const props = (create?.inputSchema.properties ?? {}) as Record<
      string,
      { description?: string }
    >;
    const secrets = props.secrets;
    expect(secrets?.description).toContain('/run/mandala-secrets/user/files');
    expect(secrets?.description).toContain('never a value');
    await close();
  });
});
