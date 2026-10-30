import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { credentialGatewayBody } from '../src/paths.js';
import { connect, GATEWAY_BINDING, installFakePlatform } from './harness.js';

// The credential gateway (OPL-6246): a secret added at the platform to the
// guest's requests for one origin, path prefix and set of methods. What is
// pinned is what a model acts on: how the guest calls through the binding
// (the answered base_url and placeholder), that the secret never reaches the
// computer, the refusals that save a round trip which could only fail, and
// bodies that are not bindings and must not be described as one.

const textOf = (res: CallToolResult) =>
  res.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

const ARGS = {
  secret_id: 'csec-0123456789abcdef',
  origin: 'https://api.example.com',
  path_prefix: '/v1',
  methods: ['GET', 'POST'],
};

async function over(body: unknown, status: number, tool: string, args: Record<string, unknown>) {
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
}

describe('credential gateway tools', () => {
  let platform: ReturnType<typeof installFakePlatform>;
  beforeEach(() => {
    platform = installFakePlatform();
  });
  afterEach(() => platform.restore());

  it('creates on the selected computer, sending exactly the policy, and says how the guest calls it', async () => {
    const { call, close } = await connect();
    const res = await call('create_credential_gateway_binding', ARGS);
    const sent = platform.calls.find(
      (c) => c.method === 'POST' && c.path === '/computers/vm-1/credential-gateway',
    );
    expect(sent?.body).toEqual(ARGS);
    expect(res.isError).toBeFalsy();
    const text = textOf(res);
    expect(text).toContain(
      `Created ${GATEWAY_BINDING.id} on vm-1: GET, POST to https://api.example.com/v1 and below, using secret csec-0123456789abcdef sent as \`Authorization: Bearer\`.`,
    );
    expect(text).toContain(`${GATEWAY_BINDING.base_url}/v1…`);
    expect(text).toContain(
      '`Authorization: Bearer mandala-placeholder` or `x-api-key: mandala-placeholder`',
    );
    expect(text).toContain('The secret never reaches the computer.');
    expect(text).toContain('10 minutes per call');
    expect(text).not.toContain('ANTHROPIC_BASE_URL');
    await close();
  });

  it('sends auth_header only when given, and says how Claude Code uses an x-api-key binding', async () => {
    const { call, close } = await connect();
    const res = await call('create_credential_gateway_binding', {
      ...ARGS,
      auth_header: 'x-api-key',
    });
    const sent = platform.calls.find((c) => c.method === 'POST');
    expect(sent?.body).toEqual({ ...ARGS, auth_header: 'x-api-key' });
    const text = textOf(res);
    expect(text).toContain('using secret csec-0123456789abcdef sent as `x-api-key`.');
    expect(text).toContain(
      `ANTHROPIC_BASE_URL=${GATEWAY_BINDING.base_url} and ANTHROPIC_API_KEY=mandala-placeholder`,
    );
    await call('create_credential_gateway_binding', { ...ARGS, auth_header: 'authorization' });
    expect(platform.calls.filter((c) => c.method === 'POST')[1]?.body).toEqual({
      ...ARGS,
      auth_header: 'authorization',
    });
    const bad = await call('create_credential_gateway_binding', { ...ARGS, auth_header: 'bearer' });
    expect(bad.isError).toBe(true);
    expect(platform.calls.filter((c) => c.method === 'POST')).toHaveLength(2);
    await close();
  });

  it('reads a listing row without auth_header as a Bearer binding', async () => {
    const { auth_header: _, ...old } = { ...GATEWAY_BINDING, auth_header: undefined };
    const res = await over(
      { bindings: [old, { ...GATEWAY_BINDING, auth_header: 'x-api-key' }] },
      200,
      'list_credential_gateway_bindings',
      {},
    );
    const text = textOf(res);
    expect(text).toContain('using secret csec-0123456789abcdef sent as `Authorization: Bearer`');
    expect(text).toContain('using secret csec-0123456789abcdef sent as `x-api-key`');
  });

  it('sends the origin as the origin it parsed to, on another computer when named', async () => {
    const { call, close } = await connect();
    await call('create_credential_gateway_binding', {
      ...ARGS,
      computer_id: 'vm-2',
      origin: 'https://API.Example.com/',
      secret_id: ' csec-0123456789abcdef ',
    });
    const sent = platform.calls.find((c) => c.method === 'POST');
    expect(sent?.path).toBe('/computers/vm-2/credential-gateway');
    expect(sent?.body).toMatchObject({
      origin: 'https://api.example.com',
      secret_id: 'csec-0123456789abcdef',
    });
    await close();
  });

  it('refuses a policy that can only fail before any request', () => {
    const bad: Array<[Partial<typeof ARGS>, RegExp]> = [
      [{ secret_id: '  ' }, /secret_id must not be empty/],
      [{ origin: 'http://api.example.com' }, /origin must be https/],
      [{ origin: 'https://api.example.com/v1' }, /no path/],
      [{ origin: 'https://api.example.com:8443' }, /port/],
      [{ origin: 'https://user:pw@api.example.com' }, /credentials/],
      [{ origin: 'https://api.example.com?' }, /query/],
      [{ origin: 'https://api.example.com#x' }, /fragment/],
      [{ origin: 'api.example.com' }, /origin must be an https/],
      [{ path_prefix: 'v1' }, /path_prefix must be an absolute path/],
      [{ path_prefix: '//v1' }, /single slash/],
      [{ path_prefix: '/v1?x=1' }, /query/],
      [{ methods: [] }, /1 to 6/],
      [{ methods: ['get'] }, /uppercase/],
      [{ methods: ['CONNECT'] }, /not "CONNECT"/],
      [{ methods: ['GET', 'GET'] }, /must not repeat/],
      [{ auth_header: 'X-API-Key' } as never, /auth_header must be/],
    ];
    for (const [patch, why] of bad) {
      expect(() => credentialGatewayBody({ ...ARGS, ...patch })).toThrow(why);
    }
    expect(credentialGatewayBody({ ...ARGS, path_prefix: '/' }).path_prefix).toBe('/');
  });

  it('refuses through the tool with nothing sent, including an unknown argument', async () => {
    const { call, close } = await connect();
    const res = await call('create_credential_gateway_binding', {
      ...ARGS,
      origin: 'https://api.example.com/v1',
    });
    expect(res.isError).toBe(true);
    const typo = await call('create_credential_gateway_binding', { ...ARGS, method: ['GET'] });
    expect(typo.isError).toBe(true);
    const dup = await call('create_credential_gateway_binding', {
      ...ARGS,
      methods: ['GET', 'GET'],
    });
    expect(dup.isError).toBe(true);
    expect(platform.calls.filter((c) => c.method === 'POST')).toEqual([]);
    await close();
  });

  it('lists bindings with how to call each, and says an empty listing is empty', async () => {
    const { call, close } = await connect();
    const text = textOf(await call('list_credential_gateway_bindings', {}));
    expect(text).toContain('1 credential gateway binding on vm-1 (of 8 allowed):');
    expect(text).toContain(
      `${GATEWAY_BINDING.id}: GET to https://api.example.com/v1 and below, using secret csec-0123456789abcdef`,
    );
    await close();

    const empty = await over({ bindings: [] }, 200, 'list_credential_gateway_bindings', {});
    expect(textOf(empty).split('\n')[0]).toBe(
      'No credential gateway bindings on vm-1. create_credential_gateway_binding makes one; a computer may have 8.',
    );
  });

  it('never reads a body that is not a listing, or holds a row that is not a binding, as one', async () => {
    for (const body of [{}, { bindings: 'none' }, [GATEWAY_BINDING]]) {
      const res = await over(body, 200, 'list_credential_gateway_bindings', {});
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('not a listing');
    }
    for (const row of [
      { ...GATEWAY_BINDING, base_url: undefined },
      { ...GATEWAY_BINDING, base_url: 'not a url' },
      { ...GATEWAY_BINDING, placeholder: '' },
      { ...GATEWAY_BINDING, methods: [] },
      { ...GATEWAY_BINDING, origin: 'http://api.example.com' },
    ]) {
      const res = await over(
        { bindings: [GATEWAY_BINDING, row] },
        200,
        'list_credential_gateway_bindings',
        {},
      );
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('1 entry that is not a binding');
    }
  });

  it('says a create answering something else may still have made the binding', async () => {
    const res = await over({ ok: true }, 201, 'create_credential_gateway_binding', ARGS);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('THE BINDING MAY HAVE BEEN CREATED');
    expect(textOf(res)).not.toContain('Created');
  });

  it('passes on a platform refusal of the create', async () => {
    const res = await over(
      { error: 'A computer can have at most 8 gateway bindings.' },
      409,
      'create_credential_gateway_binding',
      ARGS,
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('at most 8 gateway bindings');
  });

  it('revokes with confirm, says nothing was revoked on a 404, and checks the ack', async () => {
    const { call, close } = await connect();
    const noConfirm = await call('delete_credential_gateway_binding', {
      binding_id: GATEWAY_BINDING.id,
    });
    expect(noConfirm.isError).toBe(true);
    expect(platform.calls.filter((c) => c.method === 'DELETE')).toEqual([]);
    const res = await call('delete_credential_gateway_binding', {
      binding_id: GATEWAY_BINDING.id,
      confirm: true,
    });
    expect(platform.calls.find((c) => c.method === 'DELETE')?.path).toBe(
      `/computers/vm-1/credential-gateway/${GATEWAY_BINDING.id}`,
    );
    expect(textOf(res)).toContain(`Revoked ${GATEWAY_BINDING.id} on vm-1.`);
    const traversal = await call('delete_credential_gateway_binding', {
      binding_id: '../../secrets',
      confirm: true,
    });
    expect(traversal.isError).toBe(true);
    await close();

    const gone = await over(
      { error: 'binding not found' },
      404,
      'delete_credential_gateway_binding',
      { binding_id: GATEWAY_BINDING.id, confirm: true },
    );
    expect(gone.isError).toBeFalsy();
    expect(textOf(gone)).toContain('Nothing was revoked');

    const odd = await over({}, 200, 'delete_credential_gateway_binding', {
      binding_id: GATEWAY_BINDING.id,
      confirm: true,
    });
    expect(odd.isError).toBe(true);
    expect(textOf(odd)).toContain('IT MAY OR MAY NOT HAVE BEEN REVOKED');
  });
});
