import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
    expect(build).toContain('a 409 saying a secret');
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
