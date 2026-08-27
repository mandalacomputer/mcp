import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connect, installFakePlatform, type Recorded } from './harness.js';

// OPL-3835. The template store and the builds, which this server could not reach
// at all: three platform tickets' worth of surface (OPL-3789, OPL-3830,
// OPL-3791/3794) was callable from an API key and from no tool here.
//
// What is pinned below is the seam rather than the platform, and one thing more
// besides. Two of these tools are irreversible in a way their names do not
// suggest — retire_template without a version takes EVERY version, and a retired
// ref can never be republished — so what a model is TOLD is part of the
// behaviour and is asserted here like anything else. A description a model does
// not read before deciding is a 409 it reads afterwards.

const textOf = (res: CallToolResult) =>
  res.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

let platform: { calls: Recorded[]; restore: () => void };

beforeEach(() => {
  platform = installFakePlatform();
});

afterEach(() => {
  platform.restore();
});

const sent = (path: string, method = 'GET') =>
  platform.calls.find((c) => c.path === path && c.method === method);

describe('what the model is told before it decides', () => {
  it('warns on retire_template that it takes every version and cannot be undone', async () => {
    const { client, close } = await connect();
    const tools = (await client.listTools()).tools;
    const retire = tools.find((t) => t.name === 'retire_template');
    const description = retire?.description ?? '';

    // The three facts a model cannot recover from anywhere else, in the one
    // place it reads before calling.
    expect(description).toMatch(/EVERY VERSION/);
    expect(description).toMatch(/CANNOT BE UNDONE/i);
    expect(description).toMatch(/Computers are NOT affected/i);
    // And the protocol-level flag, which is what a host application gates a
    // confirmation prompt on.
    expect(retire?.annotations?.destructiveHint).toBe(true);
    await close();
  });

  it('marks the reads read-only and the writes not', async () => {
    const { client, close } = await connect();
    const tools = (await client.listTools()).tools;
    const hint = (name: string) =>
      tools.find((t) => t.name === name)?.annotations?.readOnlyHint ?? false;

    expect(hint('get_template_schema')).toBe(true);
    expect(hint('check_template')).toBe(true);
    expect(hint('get_template')).toBe(true);
    expect(hint('list_builds')).toBe(true);
    // check_template is read-only precisely because it stores nothing and claims
    // no ref; publish and build both do.
    expect(hint('publish_template')).toBe(false);
    expect(hint('build_template')).toBe(false);
    expect(hint('retire_template')).toBe(false);
    await close();
  });
});

describe('publishing and checking', () => {
  it('sends the document as bytes, not wrapped in JSON', async () => {
    const { call, close } = await connect();
    await call('publish_template', { document: 'apiVersion: mandala/v1' });
    // The platform reads JSON or YAML off the body itself. An envelope would be
    // a document its validator never sees — and would parse, so the failure
    // would be a complaint about the WRAPPER's fields.
    expect(sent('/templates', 'POST')?.body).toBe('<raw bytes>');
    await close();
  });

  it('refuses an empty document without a round trip', async () => {
    const { call, close } = await connect();
    const res = await call('publish_template', { document: '   ' });
    expect(res.isError).toBe(true);
    expect(platform.calls).toHaveLength(0);
    await close();
  });

  /**
   * An invalid document is the ANSWER to the question check_template asks, and
   * the platform says so with a 200. Marking it isError would tell the model its
   * request failed when what it got is the list of problems it asked for.
   */
  it('does not report an invalid document as a failed call', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ valid: false, problems: ['spec.os is required'] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
    const { call, close } = await connect();
    const res = await call('check_template', { document: 'apiVersion: mandala/v1' });
    globalThis.fetch = real;

    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toMatch(/NOT valid/);
    expect(textOf(res)).toMatch(/spec.os is required/);
    await close();
  });

  it('tells the model a published template is named by its ref and nothing else', async () => {
    const { call, close } = await connect();
    const res = await call('publish_template', { document: 'apiVersion: mandala/v1' });
    expect(textOf(res)).toMatch(/acc-1\/devbox@1\.0\.0/);
    expect(textOf(res)).toMatch(/named by its ref/);
    await close();
  });
});

describe('naming a version', () => {
  it('omits the parameter entirely when no version is given', async () => {
    const { call, close } = await connect();
    await call('get_template', { namespace: 'acc-1', name: 'devbox' });
    expect(sent('/templates/acc-1/devbox')?.query.has('version')).toBe(false);
    await close();
  });

  /**
   * The defect this exists to be on the right side of.
   *
   * `?version=` read as "no version was named" on the platform and retired an
   * ENTIRE template, irreversibly. A model is the caller most likely to send an
   * empty string for an optional argument, so this server refuses it rather than
   * relying on the platform's 400 — and refuses before anything is deleted.
   */
  it('refuses an empty version rather than sending it', async () => {
    const { call, close } = await connect();
    const res = await call('retire_template', {
      namespace: 'acc-1',
      name: 'devbox',
      version: '',
      confirm: true,
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/MAJOR\.MINOR\.PATCH/);
    expect(platform.calls).toHaveLength(0);
    await close();
  });

  it('refuses a version that is not MAJOR.MINOR.PATCH', async () => {
    const { call, close } = await connect();
    for (const bad of ['1.0', 'abc', '1.0.0.0', '01.0.0', 'v1.0.0']) {
      const res = await call('get_template', { namespace: 'acc-1', name: 'devbox', version: bad });
      expect(res.isError, `${bad} should be refused`).toBe(true);
    }
    expect(platform.calls).toHaveLength(0);
    await close();
  });

  /**
   * The platform reduces `templates/<a>/<b>` to `templates/:namespace/:name`, so
   * a ref handed over whole would be percent-encoded into one segment and reach
   * a route that does not exist.
   */
  it('puts the ref in the path as two segments', async () => {
    const { call, close } = await connect();
    await call('get_template', { namespace: 'acc-1', name: 'devbox', version: '1.0.0' });
    expect(sent('/templates/acc-1/devbox')?.query.get('version')).toBe('1.0.0');
    await close();
  });
});

describe('retiring one', () => {
  it('says what went, what is left, and that the ref count does not go back', async () => {
    const { call, close } = await connect();
    const res = await call('retire_template', {
      namespace: 'acc-1',
      name: 'devbox',
      confirm: true,
    });
    const said = textOf(res);

    expect(said).toMatch(/Retired 1 version/);
    expect(said).toMatch(/acc-1\/devbox@1\.0\.0/);
    expect(said).toMatch(/Nothing is published under this name any more/);
    // The two numbers move differently, and a model watching only the first
    // would conclude that retiring is free.
    expect(said).toMatch(/does not go down/);
    await close();
  });

  it('sends DELETE with no body', async () => {
    const { call, close } = await connect();
    await call('retire_template', { namespace: 'acc-1', name: 'devbox', confirm: true });
    const call_ = sent('/templates/acc-1/devbox', 'DELETE');
    expect(call_).toBeDefined();
    expect(call_?.body).toBeUndefined();
    await close();
  });
});

describe('building', () => {
  it('says the build is not finished and names what to call next', async () => {
    const { call, close } = await connect();
    const res = await call('build_template', { document: 'apiVersion: mandala/v1' });
    // A model handed a 202 with an id reads it as done unless told otherwise,
    // and then reports a build that has not started copying as a success.
    expect(textOf(res)).toMatch(/not finished/);
    expect(textOf(res)).toMatch(/watch_build/);
    await close();
  });

  it('sends no_reuse only when it is asked for', async () => {
    const { call, close } = await connect();
    await call('build_template', { document: 'apiVersion: mandala/v1' });
    expect(sent('/builds', 'POST')?.query.has('no_reuse')).toBe(false);
    await close();
  });

  it('watches a build to its done event and reports success', async () => {
    const { call, close } = await connect();
    const res = await call('watch_build', { build_id: 'bld-1' });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toMatch(/succeeded/);
    // The limitation stated where somebody will act on it, rather than found
    // later as a 503 from a create.
    expect(textOf(res)).toMatch(/does not yet advertise a family it built/);
    await close();
  });

  /**
   * A build that FAILED is an outcome with a remedy — the failed step names what
   * to fix — not a failed tool call. Marking it isError would tell the model its
   * request went wrong rather than that its document did.
   */
  it('reports a failed build as an answer, naming the step', async () => {
    const failed = {
      id: 'bld-1',
      status: 'failed',
      done: true,
      phase: 'failed',
      step: 1,
      of: 2,
      steps: [{ n: 1, kind: 'apt', label: 'nosuchpkg', status: 'failed' }],
      error: 'apt-get returned 100',
    };
    const real = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(`event: done\ndata: ${JSON.stringify(failed)}\n\n`, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })) as typeof fetch;
    const { call, close } = await connect();
    const res = await call('watch_build', { build_id: 'bld-1' });
    globalThis.fetch = real;

    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toMatch(/failed/);
    expect(textOf(res)).toMatch(/Step 1 \(apt: nosuchpkg\)/);
    expect(textOf(res)).toMatch(/apt-get returned 100/);
    await close();
  });

  /**
   * An `error` event is the STREAM failing, not the build. A model told "the
   * build failed" would go and rewrite a document that is fine — while the build
   * it gave up on is very likely still running.
   */
  it('says a stream error is not the build, and points at get_build', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('event: error\ndata: {"error":"host went away"}\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })) as typeof fetch;
    const { call, close } = await connect();
    const res = await call('watch_build', { build_id: 'bld-1' });
    globalThis.fetch = real;

    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/says nothing about the build itself/);
    expect(textOf(res)).toMatch(/get_build/);
    await close();
  });
});

// --- what an adversarial review found (OPL-3835) --------------------------

describe('a stream that stops is not a build that finished', () => {
  const stream = (body: string) =>
    (async () =>
      new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })) as typeof fetch;

  /**
   * The tool's whole promise is "watch until it finishes".
   *
   * A stream cut after a `progress` — a proxy, a host going away — fell out of
   * the loop with `last` set, and was reported through `said(...)` as a finished
   * build whose status happened to be `running`. A model reading that acts on a
   * status that was true whenever the connection died.
   */
  it('refuses when the stream ends after a progress, without a done', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = stream(
      `event: progress\ndata: ${JSON.stringify({ id: 'bld-1', status: 'running', phase: 'copying', step: 1, of: 2 })}\n\n`,
    );
    const { call, close } = await connect();
    const res = await call('watch_build', { build_id: 'bld-1' });
    globalThis.fetch = real;

    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/ended before the build did/);
    expect(textOf(res)).toMatch(/still running/);
    expect(textOf(res)).toMatch(/get_build/);
    await close();
  });

  it('refuses when the final event is malformed rather than reporting the last progress', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = stream(
      `event: progress\ndata: ${JSON.stringify({ id: 'bld-1', status: 'running' })}\n\n` +
        'event: done\ndata: "not a record"\n\n',
    );
    const { call, close } = await connect();
    const res = await call('watch_build', { build_id: 'bld-1' });
    globalThis.fetch = real;

    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/ended before the build did/);
    await close();
  });

  it('still reports a well-formed done as the answer', async () => {
    const { call, close } = await connect();
    const res = await call('watch_build', { build_id: 'bld-1' });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toMatch(/succeeded/);
    await close();
  });
});

describe('a short build listing', () => {
  /**
   * It never reaches this server as a short list, and that is the point.
   *
   * lib/hvproxy does set X-GC-Incomplete on one, but `forward` in lib/surface
   * applies its strict-inventory check to every v1 route generically — so the
   * response is a 503 before this server sees it. An earlier version of this
   * tool read the header, on the strength of a review that had looked at
   * lib/hvproxy and not at the tier above it.
   */
  it('arrives as a refusal, so the list a model sees is the truth', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error:
            'Right now a hypervisor cannot be reached, so this list would be incomplete. ' +
            'Retry, or pass allow_partial=1 to accept a partial answer.',
        }),
        {
          status: 503,
          headers: { 'Content-Type': 'application/json', 'X-GC-Incomplete': '0' },
        },
      )) as typeof fetch;
    const { call, close } = await connect();
    const res = await call('list_builds');
    globalThis.fetch = real;

    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/would be incomplete/);
    await close();
  });

  it('is an ordinary list when the fleet answered in full', async () => {
    const { call, close } = await connect();
    const res = await call('list_builds');
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toMatch(/bld-1/);
    await close();
  });
});

describe('what /code-review found', () => {
  /**
   * The repo's own convention for an unrecoverable tool.
   *
   * delete_computer, restore_snapshot and delete_snapshot all take
   * `confirm: z.literal(true)`. Retiring is strictly LESS recoverable than any
   * of them — a deleted snapshot's name can be used again, a retired ref never
   * can — and it was the only one without a gate.
   */
  it('will not retire without confirm, and the schema says so', async () => {
    const { client, call, close } = await connect();
    const res = await call('retire_template', { namespace: 'acc-1', name: 'devbox' });
    expect(res.isError).toBe(true);
    expect(platform.calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);

    const tools = (await client.listTools()).tools;
    const retire = tools.find((t) => t.name === 'retire_template');
    expect(retire?.inputSchema.required).toContain('confirm');
    await close();
  });

  /**
   * `progress` is not a superset of the job record. The two projectors overlap
   * only on id, status and error: publicTemplateBuild carries `ref` and both
   * timestamps, publicBuildProgress carries the phase and the steps. Read as
   * progress alone, get_build could not say which template a build was for.
   */
  it('tells the model which template a build was for, and where it got to', async () => {
    const { call, close } = await connect();
    const res = await call('get_build', { build_id: 'bld-1' });
    const said = textOf(res);
    expect(said).toMatch(/acc-1\/devbox@1\.0\.0/); // ref, from the job record
    expect(said).toMatch(/"phase"/); // phase, from progress
    expect(said).toMatch(/"started_at"/);
    await close();
  });

  /**
   * The MCP SDK's default request timeout is 60s and only `notifications/progress`
   * resets it — `_onprogress` is bound to that schema alone. A logging
   * notification is not a keepalive, so a fifteen-minute build was cancelled at
   * sixty seconds on a default client.
   */
  it('sends progress notifications when the client asked for them', async () => {
    const { client, close } = await connect();
    const seen: { progress: number; message?: string }[] = [];
    // `onprogress` is the SDK's own mechanism: it registers the handler AND
    // mints the progressToken, which is what the server needs in order to
    // address a notification back at this request.
    await client.callTool({ name: 'watch_build', arguments: { build_id: 'bld-1' } }, undefined, {
      onprogress: (p) => {
        seen.push(p as { progress: number; message?: string });
      },
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((p) => (p.message ?? '').includes('copying'))).toBe(true);
    await close();
  });
});

describe('what the second review pass found', () => {
  const answer = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  /**
   * A partial answer is still an answer.
   *
   * The two legs are independent fleet walks, so one can fail while the other
   * succeeds. Promise.all threw the good half away — and the half it threw away
   * is the one a model calls get_build for after a build nobody watched.
   */
  it('still answers when the job record cannot be read', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/progress')) {
        return answer({ id: 'bld-1', status: 'failed', phase: 'failed', error: 'apt died' });
      }
      return answer({ error: 'no hypervisor could answer' }, 503);
    }) as typeof fetch;
    const { call, close } = await connect();
    const res = await call('get_build', { build_id: 'bld-1' });
    globalThis.fetch = real;

    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toMatch(/apt died/);
    expect(textOf(res)).toMatch(/could not be read/);
    await close();
  });

  /**
   * The two reads race, so a build that finishes between them merged into a
   * record contradicting itself: `done: false` beside a populated finished_at.
   */
  it('does not report a finish time for a build progress says is running', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL) => {
      const path = new URL(String(input)).pathname;
      return path.endsWith('/progress')
        ? answer({ id: 'bld-1', status: 'running', done: false, phase: 'copying' })
        : answer({
            id: 'bld-1',
            ref: 'acc-1/devbox@1.0.0',
            status: 'succeeded',
            started_at: '2026-08-26T12:00:00.000Z',
            finished_at: '2026-08-26T12:15:00.000Z',
          });
    }) as typeof fetch;
    const { call, close } = await connect();
    const res = await call('get_build', { build_id: 'bld-1' });
    globalThis.fetch = real;

    const body = JSON.parse(textOf(res));
    expect(body.done).toBe(false);
    expect(body.finished_at).toBeUndefined();
    // The half that does not race is kept.
    expect(body.ref).toBe('acc-1/devbox@1.0.0');
    expect(body.started_at).toBe('2026-08-26T12:00:00.000Z');
    await close();
  });

  /**
   * The SDK's ProgressSchema asks that `progress` increase every time. `step` is
   * 0 for every pre-step phase and for the whole life of a document with no
   * build steps, so successive frames repeated `progress: 0`.
   */
  it('sends a progress value that increases', async () => {
    const { client, close } = await connect();
    const seen: number[] = [];
    await client.callTool({ name: 'watch_build', arguments: { build_id: 'bld-1' } }, undefined, {
      onprogress: (p) => {
        seen.push((p as { progress: number }).progress);
      },
    });
    expect(seen.length).toBeGreaterThan(1);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(new Set(seen).size).toBe(seen.length);
    await close();
  });
});
