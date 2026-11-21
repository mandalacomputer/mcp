import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Api } from '../src/api.js';
import { connect, installFakePlatform } from './harness.js';

/**
 * Tool and argument descriptions the pre-0.8.0 audit found wrong against the
 * platform (OPL-5437). In an MCP server the description is the interface: it
 * is what the model reads before deciding to call.
 */
describe('descriptions corrected for 0.8.0', () => {
  let platform: ReturnType<typeof installFakePlatform>;
  let connection: Awaited<ReturnType<typeof connect>>;
  let tools: Awaited<ReturnType<typeof connection.client.listTools>>['tools'];
  beforeEach(async () => {
    platform = installFakePlatform();
    connection = await connect();
    tools = (await connection.client.listTools()).tools;
  });
  afterEach(async () => {
    await connection.close();
    platform.restore();
  });
  const tool = (name: string) => tools.find((t) => t.name === name);
  const arg = (name: string, field: string) => {
    const props = tool(name)?.inputSchema.properties as
      | Record<string, { description?: string }>
      | undefined;
    return props?.[field]?.description ?? '';
  };

  it('says a short template name falls back to base only while the catalogue is complete', () => {
    for (const said of [arg('create_computer', 'template'), tool('list_templates')?.description]) {
      expect(said).toContain('falls back to base');
      expect(said).toContain('INCOMPLETE');
      expect(said).toContain('retryable 503 that changed nothing');
      expect(said).toContain('same idempotency_key');
      expect(said).not.toContain('the host lacks');
      expect(said).not.toContain('falls back to the default');
    }
    expect(tool('list_templates')?.description).toContain('minimum disk');
  });

  it('states the system parent rule and the spec.secrets rules for a build', () => {
    const build = tool('build_template')?.description ?? '';
    expect(build).toContain('`system/...` template');
    expect(build).toContain('never by value');
    expect(build).toContain('at most 32');
    expect(build).toContain('not worth retrying');
    expect(build).toContain('a 409 with reason unsupported');
    const check = tool('check_template')?.description ?? '';
    expect(check).toContain('system/... template');
    expect(check).toContain('cap of 32 references');
  });

  it('says every exec sees bound variables, and drops the plain-exec hedge', () => {
    expect(arg('exec', 'desktop')).toContain('every exec, plain or desktop');
    expect(arg('exec', 'desktop')).not.toContain('depends on the platform version');
    expect(arg('create_computer', 'secrets')).toContain('every exec, plain or with desktop: true');
  });

  it('counts webhook attempts, not retries', () => {
    const said = tool('create_webhook')?.description ?? '';
    expect(said).toContain('eight attempts (seven retries)');
    expect(said).not.toContain('retried eight times');
  });

  it('says a lifecycle 5xx that names no operation is resent with the same key', () => {
    for (const name of ['create_computer', 'start_computer', 'restart_computer']) {
      expect(arg(name, 'idempotency_key')).toContain(
        'After a 5xx that names no operation_id, send the same call again with the same key',
      );
    }
  });

  it("agrees with update_computer's own error on the key to resend egress_proxy with", () => {
    // keyedFailure answers a 5xx that names no operation_id with "the SAME
    // idempotency_key ... Do not switch to a new key or none"; the argument
    // description must not tell the model the opposite for the same answer.
    const said = arg('update_computer', 'egress_proxy');
    expect(said).toContain(
      'After any other 5xx that names no operation_id, send the setting again with the SAME idempotency_key (not a new one or none)',
    );
    expect(said).toContain(
      'with a new idempotency_key, or none, after a 5xx that names an operation_id',
    );
    expect(said).not.toContain('with a new idempotency_key, or none, after a 5xx;');
  });
});

describe('clipboard, paste and end-time descriptions match what the platform serves', () => {
  let platform: ReturnType<typeof installFakePlatform>;
  let connection: Awaited<ReturnType<typeof connect>>;
  let tools: Awaited<ReturnType<typeof connection.client.listTools>>['tools'];
  beforeEach(async () => {
    platform = installFakePlatform();
    connection = await connect();
    tools = (await connection.client.listTools()).tools;
  });
  afterEach(async () => {
    await connection.close();
    platform.restore();
  });
  const tool = (name: string) => tools.find((t) => t.name === name);

  it.each(['read_clipboard', 'write_clipboard', 'paste_text'])(
    '%s no longer says Windows is refused, and names the desktop-session 409',
    (name) => {
      const said = tool(name)?.description ?? '';
      expect(said).not.toMatch(/refused on Windows|Windows and a guest|Linux desktops only/);
      expect(said).toContain('runs in the signed-in desktop session');
      expect(said).toContain('answers a 409 that names no reason');
      expect(said).toContain('a bounded number of times');
    },
  );

  it('does not tell get_desktop_url callers the clipboard tools are refused on Windows', async () => {
    const res = await connection.call('get_desktop_url', { control: true });
    const said = res.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
    expect(said).toContain('TO MOVE TEXT, use read_clipboard and write_clipboard');
    expect(said).not.toContain('refused outright on Windows');
    expect(said).toContain(
      'paste into the desktop. They also work on Windows, through the signed-in desktop session.',
    );
  });

  it('says an end time changed during its own stop is a 409 with reason contention', () => {
    const props = tool('update_computer')?.inputSchema.properties as Record<
      string,
      { description?: string }
    >;
    const said = props.ends_at?.description ?? '';
    expect(said).toContain(
      'Refused with a 409 and reason contention while the computer is being stopped',
    );
    expect(said).not.toContain('409 that names no reason while');
  });
});

describe('the docs agree with the agent tools on what a failure status means', () => {
  const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

  it("does not tell the skill's reader a mid-run stop may be the Mandala plan", () => {
    const skill = read('plugin/skills/mandala-computer/SKILL.md');
    expect(skill).not.toContain('a plan that no longer covers the work');
    expect(skill).toContain('a `401` or `403` carrying `reason: "revoked"`');
    expect(skill).toContain("the model provider's own\n  status for the model key");
  });

  it("keeps run_agent_chat's pre-run refusals on the usual advice in the README", () => {
    const readme = read('README.md');
    expect(readme).toContain('before any run started — a flat\n`{error: string}` body');
    expect(readme).toContain('it keeps the usual role and plan advice');
  });
});

describe('where the docs send a reader for an API key (OPL-5489)', () => {
  // API keys sit under Settings → Credentials in the dashboard; a "Settings →
  // API keys" tab no longer exists. Matched across line breaks, since prose wraps.
  const stale = /Settings\s*(→|->|>)\s*API keys/i;

  it('names Settings → Credentials → API keys when no key is given', () => {
    expect(() => new Api('')).toThrow(/create one at Settings → Credentials → API keys/);
  });

  it('never names a Settings → API keys tab in the README or the skill', () => {
    for (const path of ['README.md', 'plugin/skills/mandala-computer/SKILL.md']) {
      expect(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'), path).not.toMatch(stale);
    }
  });
});
