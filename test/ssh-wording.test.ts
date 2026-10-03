import { describe, expect, it } from 'vitest';
import { connect } from './harness.js';

// What the SSH tools tell a model about removing a key and switching SSH on
// (OPL-5640). The platform closes a session opened with a removed key as each
// computer receives the new key list, and never admits a seat-suspended
// member's keys; a description that said otherwise would have a model promise
// a user their shell survives, or count keys that cannot log in.

describe('the SSH tool descriptions', () => {
  it('say removing a key closes the sessions opened with it, and who is admitted', async () => {
    const { client, close } = await connect();
    const tools = (await client.listTools()).tools;
    const about = (name: string) => tools.find((t) => t.name === name)?.description ?? '';

    const remove = about('remove_ssh_key');
    expect(remove).not.toContain('until it disconnects');
    expect(remove).toContain(
      'any session opened with it is closed as each computer receives the new key list',
    );

    const set = about('set_computer_ssh');
    expect(set).toContain(
      'except keys added through an API key or connected app on another account, and keys of a member whose seat is suspended',
    );
    await close();
  });
});
