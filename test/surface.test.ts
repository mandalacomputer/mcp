import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ALLOWED,
  PARAMETERS,
  patternFor,
  UNIMPLEMENTED,
  UNIMPLEMENTED_PARAMETERS,
} from './allowlist.js';
import { connect, installFakePlatform, type Recorded } from './harness.js';
import { collectExercises, EXERCISE } from './surface-exercise.js';

const routesOf = (calls: Recorded[]) =>
  new Set(calls.map((c) => `${c.method} ${patternFor(c.path)}`));

/** Generic HTTP machinery rather than route parameters. */
const GENERIC_HEADERS = new Set(['authorization', 'accept', 'content-type', 'accept-encoding']);

/** Preserve the platform table's spelling while matching names case-insensitively. */
const DOCUMENTED_HEADERS = new Map(
  [...PARAMETERS.values()]
    .flat()
    .flatMap((p) => (p.startsWith('header:') ? [[p.slice(7).toLowerCase(), p.slice(7)]] : [])),
);

/** What one call actually carried, in the mirror's spelling. */
function parametersOf(call: Recorded): string[] {
  const sent = [
    ...[...call.query.keys()].map((k) => `query:${k}`),
    // Enumerate what actually went out, excluding transport/auth/content negotiation.
    // Accept-Encoding requests identity for exact retained byte counts. Known parameters use the platform table's spelling;
    // anything unknown keeps its wire spelling so the comparison rejects it.
    ...Object.keys(call.headers)
      .filter((h) => !GENERIC_HEADERS.has(h.toLowerCase()))
      .map((h) => `header:${DOCUMENTED_HEADERS.get(h.toLowerCase()) ?? h}`),
  ];
  // Only an object body has named fields. A file upload's body is the file.
  if (call.body && typeof call.body === 'object' && !Array.isArray(call.body)) {
    sent.push(...Object.keys(call.body).map((k) => `body:${k}`));
  }
  return sent;
}

/** Everything this server sent, by route. */
function sentParameters(calls: Recorded[]): Map<string, Set<string>> {
  const byRoute = new Map<string, Set<string>>();
  for (const call of calls) {
    const route = `${call.method} ${patternFor(call.path)}`;
    const set = byRoute.get(route) ?? new Set<string>();
    for (const p of parametersOf(call)) set.add(p);
    byRoute.set(route, set);
  }
  return byRoute;
}

describe('the surface this server calls', () => {
  let platform: ReturnType<typeof installFakePlatform>;

  beforeEach(() => {
    platform = installFakePlatform();
  });
  afterEach(() => platform.restore());

  it('exercises every tool it registers', async () => {
    const { client, close } = await connect({ modelKey: 'sk-ant-test' });
    const { tools } = await client.listTools();
    await close();
    const names = tools.map((t) => t.name).sort();
    const covered = Object.keys(EXERCISE).sort();
    expect(names).toEqual(covered);
  });

  it('lands successful exercised calls on mirrored operations with no omissions', async () => {
    const calls = (await collectExercises()).flatMap((e) => e.requests);
    const called = routesOf(calls);
    expect([...called].filter((r) => !ALLOWED.has(r))).toEqual([]);
    expect([...ALLOWED].filter((r) => !called.has(r) && !UNIMPLEMENTED.has(r))).toEqual([]);
    // An unimplemented operation is a mirrored one nobody calls, and stops being
    // listed the moment a tool reaches it.
    expect([...UNIMPLEMENTED].filter((r) => !ALLOWED.has(r) || called.has(r))).toEqual([]);
  });

  it('sends only parameters the platform documents', async () => {
    const calls = (await collectExercises()).flatMap((e) => e.requests);
    const outside: string[] = [];
    for (const [route, sent] of sentParameters(calls)) {
      const known = new Set(PARAMETERS.get(route) ?? []);
      for (const p of sent) if (!known.has(p)) outside.push(`${route}  ${p}`);
    }
    expect(outside.sort()).toEqual([]);
  });

  it('records an undocumented header instead of filtering it out', () => {
    const call: Recorded = {
      method: 'GET',
      path: '/computers',
      query: new URLSearchParams(),
      body: undefined,
      headers: {
        authorization: 'Bearer test',
        accept: 'application/json',
        'content-type': 'application/json',
        'x-obsolete-paramter': 'true',
      },
    };
    expect(parametersOf(call)).toContain('header:x-obsolete-paramter');
  });

  it('leaves exactly the pinned part of the parameter surface unsent', async () => {
    // The test the route table could not be: `Range` was documented, on a route
    // this server called on every read_file, and unsendable — and every other
    // test in this file passed for the whole time that was true.
    const calls = (await collectExercises()).flatMap((e) => e.requests);
    const sent = sentParameters(calls);
    const unsent: string[] = [];
    for (const [route, params] of PARAMETERS) {
      // A route nobody calls sends none of its parameters; its own line in
      // UNIMPLEMENTED already says so, and repeating it here per parameter
      // would bury the ones that are genuinely missing.
      if (UNIMPLEMENTED.has(route)) continue;
      const actual = sent.get(route) ?? new Set<string>();
      for (const p of params) if (!actual.has(p)) unsent.push(`${route}  ${p}`);
    }
    expect(unsent.sort()).toEqual([...UNIMPLEMENTED_PARAMETERS].sort());
  });

  it('withholds the lifecycle tools when they are turned off', async () => {
    const { client, close } = await connect({ lifecycle: false });
    const names = (await client.listTools()).tools.map((t) => t.name);
    await close();
    for (const gated of [
      'create_computer',
      'clone_computer',
      'delete_computer',
      'delete_snapshot',
    ]) {
      expect(names).not.toContain(gated);
    }
    // Power is not lifecycle: a server that may only attach still has to be
    // able to bring a computer up.
    expect(names).toContain('start_computer');
    expect(names).toContain('screenshot');
  });

  it('does not offer run_agent without a model key', async () => {
    const { client, close } = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    await close();
    expect(names).not.toContain('run_agent');
    expect(names).not.toContain('run_agent_chat');
  });
});

describe('patternFor', () => {
  it('treats ids as ids', () => {
    expect(patternFor('/computers/vm-1/start')).toBe('computers/:id/start');
    expect(patternFor('/snapshots/snap-1/clone')).toBe('snapshots/:id/clone');
    expect(patternFor('/computers/vm-1/exec/103457')).toBe('computers/:id/exec/:pid');
    expect(patternFor('/computers/vm-1/windows/0x2600003')).toBe('computers/:id/windows/:window');
    expect(patternFor('/webhooks/whk-9f3c1a7e5b2d4c80/deliveries')).toBe('webhooks/:id/deliveries');
    expect(patternFor('/ssh-keys/sshk-3c9a51d07be2f846')).toBe('ssh-keys/:id');
    expect(patternFor('/computers/vm-1/activities/act_0123456789abcdef0123456789abcdef')).toBe(
      'computers/:id/activities/:activity',
    );
    expect(
      patternFor('/computers/vm-1/activities/act_0123456789abcdef0123456789abcdef/results'),
    ).toBe('computers/:id/activities/:activity/results');
    expect(patternFor('/secrets')).toBe('secrets');
    expect(patternFor('/secrets/csec-0123456789abcdef')).toBe('secrets/:id');
    expect(patternFor('/computers/vm-1/secrets')).toBe('computers/:id/secrets');
    // A computer whose id looks like a route segment is still an id.
    expect(patternFor('/computers/audit')).toBe('computers/:id');
  });
});

describe('the allowlist itself', () => {
  it("reaches none of the daemon's ops routes", () => {
    // The previous tests prove this server stays inside ALLOWED. This proves
    // ALLOWED stays honest, so widening it later is a deliberate act. None of
    // these are owner-scoped inside the daemon.
    //
    // `retention` WAS in this set and came out of it deliberately (OPL-3767,
    // OPL-3783), which is the act this test exists to force. The platform put
    // `GET retention` on its public allowlist — the READ is tenant API now,
    // answered from the plan catalogue by the control plane rather than
    // forwarded to a daemon at all — and the reason recorded here was wrong
    // besides: `PUT /retention` IS owner-scoped, it sets the calling tenant's
    // own policy. What keeps the WRITE off every surface is that the plan owns
    // retention, so a tenant setting its own would be granting itself history it
    // has not paid for. A head-segment check cannot tell a GET from a PUT, so
    // the test below is what holds that line.
    const internal = new Set(['audit', 'host', 'fleet']);
    for (const route of ALLOWED) {
      const first = route.split(' ')[1].split('/')[0];
      expect(internal.has(first), `${route} reaches an ops endpoint`).toBe(false);
    }
  });

  it('reaches retention only to read it', () => {
    // The plan owns the window, so a write to it is a tenant granting itself a
    // longer history than it pays for. The platform refuses one on both its
    // surfaces; this is the mirror of that refusal, so a PUT could not be added
    // to ALLOWED without deleting a test.
    const verbs = [...ALLOWED].filter((r) => r.endsWith(' retention')).map((r) => r.split(' ')[0]);
    expect(verbs).toEqual(['GET']);
  });
});
