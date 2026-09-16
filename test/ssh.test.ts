import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connect, installFakePlatform, SSH_KEY, SSH_PUBLIC_KEY, SSH_SETTING } from './harness.js';

// The SSH tools: the caller's public keys, and one computer's switch. What is
// pinned is the sentence a model acts on, and the refusals that stop it acting
// on a body this server could not read.

const textOf = (res: CallToolResult) =>
  res.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

describe('the SSH tools', () => {
  let platform: ReturnType<typeof installFakePlatform>;
  beforeEach(() => {
    platform = installFakePlatform();
  });
  afterEach(() => platform.restore());

  it('sends the key line as given, and the name only when there is one', async () => {
    const { call, close } = await connect();
    const added = await call('add_ssh_key', { public_key: SSH_PUBLIC_KEY });
    expect(added.isError).toBeFalsy();
    expect(textOf(added)).toContain(`Added ${SSH_KEY.id}`);
    expect(textOf(added)).toContain(SSH_KEY.fingerprint);
    await call('add_ssh_key', { public_key: SSH_PUBLIC_KEY, name: 'laptop' });
    const sent = platform.calls.filter((c) => c.method === 'POST' && c.path === '/ssh-keys');
    expect(sent.map((c) => c.body)).toEqual([
      { public_key: SSH_PUBLIC_KEY },
      { public_key: SSH_PUBLIC_KEY, name: 'laptop' },
    ]);
    await close();
  });

  it('refuses a private key without sending anything', async () => {
    const { call, close } = await connect();
    const res = await call('add_ssh_key', {
      public_key: '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n',
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('private key');
    expect(platform.calls.filter((c) => c.path === '/ssh-keys')).toEqual([]);
    await close();
  });

  it('lists keys by id, type, fingerprint and name', async () => {
    const { call, close } = await connect();
    const text = textOf(await call('list_ssh_keys', {}));
    expect(text).toContain('1 SSH key, oldest first');
    expect(text).toContain(`${SSH_KEY.id}  ssh-ed25519  ${SSH_KEY.fingerprint}  laptop`);
    await close();
  });

  it('removes by id, in the path, and only with confirmation', async () => {
    const { call, close } = await connect();
    const res = await call('remove_ssh_key', { key_id: SSH_KEY.id, confirm: true });
    expect(textOf(res)).toContain(`Removed ${SSH_KEY.id}`);
    expect(platform.calls.at(-1)).toMatchObject({
      method: 'DELETE',
      path: `/ssh-keys/${SSH_KEY.id}`,
    });
    const refused = await call('remove_ssh_key', { key_id: SSH_KEY.id });
    expect(refused.isError).toBe(true);
    const bad = await call('remove_ssh_key', { key_id: 'a/b', confirm: true });
    expect(bad.isError).toBe(true);
    await close();
  });

  it('reads and sets one computer’s switch, both ways', async () => {
    const { call, close } = await connect();
    const read = textOf(await call('get_computer_ssh', { computer_id: 'vm-7' }));
    expect(read).toContain('SSH is ON for vm-7');
    const on = textOf(await call('set_computer_ssh', { computer_id: 'vm-7', enabled: true }));
    expect(on).toContain('SSH is ON for vm-7');
    expect(on).toContain('1 key');
    const off = await call('set_computer_ssh', { computer_id: 'vm-7', enabled: false });
    expect(off.isError).toBeFalsy();
    expect(textOf(off)).toMatch(/^SSH is off for vm-7\./);
    expect(textOf(off)).not.toContain('can log in');
    const puts = platform.calls.filter((c) => c.method === 'PUT');
    expect(puts.map((c) => [c.path, c.body])).toEqual([
      ['/computers/vm-7/ssh', { enabled: true }],
      ['/computers/vm-7/ssh', { enabled: false }],
    ]);
    await close();
  });
});

describe('the SSH tools over answers they cannot trust', () => {
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

  it('does not call an unreadable listing an empty one', async () => {
    for (const body of [{ error: 'gateway' }, [SSH_KEY, null]]) {
      const res = await over(body, 200, 'list_ssh_keys', {});
      expect(res.isError).toBe(true);
      expect(textOf(res)).not.toContain('No SSH keys are registered');
    }
    const empty = await over([], 200, 'list_ssh_keys', {});
    expect(textOf(empty)).toContain('No SSH keys are registered to you');
  });

  it('says an add may have happened when the answer carries no id', async () => {
    const res = await over({}, 201, 'add_ssh_key', { public_key: SSH_PUBLIC_KEY });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('MAY HAVE BEEN ADDED');
  });

  it('does not say a key was removed when the platform has no such key', async () => {
    const res = await over({ error: 'ssh key not found' }, 404, 'remove_ssh_key', {
      key_id: SSH_KEY.id,
      confirm: true,
    });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain('Nothing was removed');
    expect(textOf(res)).not.toMatch(/^Removed/);
  });

  it('says plainly when a computer cannot run SSH', async () => {
    const res = await over({ ...SSH_SETTING, available: false }, 200, 'get_computer_ssh', {
      computer_id: 'vm-1',
    });
    expect(textOf(res)).toContain('CANNOT RUN SSH');
  });

  it('says a setting is not yet delivered, and when capability is unknown', async () => {
    const res = await over(
      { ...SSH_SETTING, available: null, pending: true },
      200,
      'get_computer_ssh',
      {
        computer_id: 'vm-1',
      },
    );
    const text = textOf(res);
    expect(text).toContain('has not received this setting yet');
    expect(text).toContain('not known until it next starts');
  });

  it('says when the hypervisor refused the setting, instead of calling it on', async () => {
    const error = 'The hypervisor refused this setting (status 400).';
    const res = await over({ ...SSH_SETTING, error }, 200, 'get_computer_ssh', {
      computer_id: 'vm-1',
    });
    const text = textOf(res);
    expect(text).toContain('REFUSED');
    expect(text).toContain(error);
    expect(text).not.toContain('can log in');
  });

  it('reads an answer that has no error field at all', async () => {
    const { error: _omitted, ...older } = SSH_SETTING;
    expect(older).not.toHaveProperty('error');
    const res = await over(older, 200, 'get_computer_ssh', { computer_id: 'vm-1' });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toMatch(/^SSH is ON for vm-1\. 1 key/);
  });

  it('reads an empty or blank error as no refusal', async () => {
    for (const error of ['', '   ']) {
      const res = await over({ ...SSH_SETTING, error }, 200, 'get_computer_ssh', {
        computer_id: 'vm-1',
      });
      expect(res.isError).toBeFalsy();
      expect(textOf(res)).not.toContain('REFUSED');
      expect(textOf(res)).toMatch(/^SSH is ON for vm-1\. 1 key/);
    }
  });

  it('keeps a refusal on a switch, with the requested value answered back', async () => {
    const error = 'The hypervisor refused this setting (status 400).';
    const res = await over({ ...SSH_SETTING, enabled: true, error }, 200, 'set_computer_ssh', {
      computer_id: 'vm-1',
      enabled: true,
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(
      /^SSH is ON for vm-1, but its hypervisor REFUSED this setting, so the computer does not have it: The hypervisor refused this setting \(status 400\)\.\n/,
    );
  });

  it('keeps a refusal on a switch, with the opposite value answered back', async () => {
    const error = 'The hypervisor refused this setting (status 413).';
    const res = await over({ ...SSH_SETTING, enabled: false, error }, 200, 'set_computer_ssh', {
      computer_id: 'vm-1',
      enabled: true,
    });
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toMatch(
      /^SSH is off for vm-1, but its hypervisor REFUSED this setting, so the computer does not have it: The hypervisor refused this setting \(status 413\)\. The platform also answered that SSH is off, not on as asked\.\n/,
    );
    expect(text).not.toContain('Nothing here assumes which is true');
  });

  it('refuses a setting it cannot read, or one that contradicts the request', async () => {
    for (const body of [
      {},
      { ...SSH_SETTING, key_count: -1 },
      { ...SSH_SETTING, available: 'yes' },
      { ...SSH_SETTING, error: 5 },
    ]) {
      const res = await over(body, 200, 'get_computer_ssh', { computer_id: 'vm-1' });
      expect(res.isError).toBe(true);
    }
    const contradicted = await over({ ...SSH_SETTING, enabled: false }, 200, 'set_computer_ssh', {
      computer_id: 'vm-1',
      enabled: true,
    });
    expect(contradicted.isError).toBe(true);
    expect(textOf(contradicted)).toContain('get_computer_ssh');
  });
});
