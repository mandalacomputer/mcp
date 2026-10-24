import type { CallToolResult, JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MAX_TOOL_INPUT_ELEMENTS, oversizedArgumentsRefusal, strictInput } from '../src/server.js';
import { connect, fakeEvents, installFakePlatform } from './harness.js';
import { checkInventory, EXERCISE, FUNDED_EXERCISE } from './surface-exercise.js';

// Every tool refuses an argument it does not know (OPL-5975). The SDK turns a
// plain field map into an object that strips unknown keys while the listed
// schema says `additionalProperties: false`, so a misspelt argument was dropped
// and the call went ahead without it: create_secret with `workspaceId` stored
// the secret account-wide, start_computer with `resume_onyl` did a full start,
// and delete_computer with a misspelt flag deleted.

const UNKNOWN = 'zz_not_an_argument';

const textOf = (res: CallToolResult) =>
  res.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

type Registered = Record<string, { inputSchema?: unknown }>;
const registeredOf = (server: unknown) =>
  (server as { _registeredTools: Registered })._registeredTools;

/** Every object schema reachable inside `schema`, with where it is. */
function objectsIn(schema: unknown, at: string, out: [string, z.ZodObject][]): void {
  if (schema instanceof z.ZodObject) {
    out.push([at, schema]);
    for (const [key, field] of Object.entries(schema.shape as Record<string, unknown>))
      objectsIn(field, `${at}.${key}`, out);
  } else if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault ||
    schema instanceof z.ZodPrefault ||
    schema instanceof z.ZodNonOptional ||
    schema instanceof z.ZodReadonly ||
    schema instanceof z.ZodCatch
  ) {
    objectsIn(schema._zod.def.innerType, at, out);
  } else if (schema instanceof z.ZodPipe) {
    objectsIn(schema._zod.def.in, at, out);
  } else if (schema instanceof z.ZodLazy) {
    objectsIn(schema._zod.def.getter(), at, out);
  } else if (schema instanceof z.ZodArray) {
    objectsIn(schema.element, `${at}[]`, out);
  } else if (schema instanceof z.ZodUnion) {
    // A discriminated union is a union too.
    for (const [i, option] of (schema.options as unknown[]).entries())
      objectsIn(option, `${at}|${i}`, out);
  } else if (schema instanceof z.ZodIntersection) {
    objectsIn(schema._zod.def.left, at, out);
    objectsIn(schema._zod.def.right, at, out);
  } else if (schema instanceof z.ZodRecord) {
    objectsIn(schema._zod.def.valueType, `${at}{}`, out);
  } else if (schema instanceof z.ZodTuple) {
    for (const [i, item] of (schema._zod.def.items as unknown[]).entries())
      objectsIn(item, `${at}[${i}]`, out);
  }
}

describe('unknown arguments', () => {
  let platform: ReturnType<typeof installFakePlatform>;
  beforeEach(() => {
    platform = installFakePlatform();
  });
  afterEach(() => platform.restore());

  // Each tool is called with arguments the surface test proves are enough to
  // reach the platform, plus one key no tool declares. The refusal has to name
  // that key — so it is the key that was refused, not something else about the
  // call — and nothing may have reached the platform: no request, no socket.
  it('every registered tool refuses an unknown key before sending anything', async () => {
    const sessions = [
      { cfg: { modelKey: 'sk-ant-fixture', tags: [], readOnly: false }, exercise: EXERCISE },
      { cfg: { funded: true, tags: [], readOnly: false }, exercise: FUNDED_EXERCISE },
    ];
    let checked = 0;
    for (const { cfg, exercise } of sessions) {
      const events = fakeEvents();
      const { client, call, close } = await connect({ ...cfg, webSocket: events.factory });
      try {
        const names = (await client.listTools()).tools.map((t) => t.name);
        if (exercise === EXERCISE) checkInventory(names, EXERCISE);
        for (const [name, variants] of Object.entries(exercise)) {
          for (const args of variants) {
            const before = platform.calls.length;
            const res = await call(name, { ...args, [UNKNOWN]: true }).catch(
              (err: unknown): CallToolResult => ({
                isError: true,
                content: [{ type: 'text', text: String(err) }],
              }),
            );
            expect(res.isError, name).toBe(true);
            expect(textOf(res), name).toContain(UNKNOWN);
            expect(textOf(res), name).toMatch(/Unrecognized keys?:/);
            expect(platform.calls.slice(before), name).toEqual([]);
            checked++;
          }
        }
        expect(events.sockets, 'a socket was opened for a refused call').toEqual([]);
      } finally {
        await close();
      }
    }
    // Every variant of every tool, keyed and funded: well over a hundred.
    expect(checked).toBeGreaterThan(115);
  });

  // Codex, round 5 on #213: the SDK's parse of the request envelope drops a
  // top-level `__proto__` argument before any tool schema runs, so a delete
  // carrying one went ahead. Own keys only arise from JSON, as here.
  it('refuses a top-level __proto__ argument before anything is sent', async () => {
    const { client, close } = await connect();
    try {
      const args = JSON.parse(
        '{"computer_id":"vm-1","confirm":true,"__proto__":{"delete_snapshots":true}}',
      ) as Record<string, unknown>;
      expect(Object.hasOwn(args, '__proto__')).toBe(true);
      const res = (await client.callTool({ name: 'delete_computer', arguments: args }).catch(
        (err: unknown): CallToolResult => ({
          isError: true,
          content: [{ type: 'text', text: String(err) }],
        }),
      )) as CallToolResult;
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('Unrecognized key: "__proto__"');
      expect(platform.calls).toEqual([]);
      // The same call without it goes through, so the refusal was the key.
      const ok = (await client.callTool({
        name: 'delete_computer',
        arguments: { computer_id: 'vm-1', confirm: true },
      })) as CallToolResult;
      expect(ok.isError).toBeFalsy();
      expect(platform.calls.map((c) => c.method)).toEqual(['DELETE']);
    } finally {
      await close();
    }
  });

  // The __proto__ refusal is written by hand, so it has to keep up with the
  // words the SDK and its validator use for every other unknown argument: a
  // model told two different things about the same mistake reads them as two.
  it('refuses __proto__ in the same words as any other unknown argument', async () => {
    const { client, close } = await connect();
    try {
      const refusal = async (json: string) => {
        const res = (await client
          .callTool({
            name: 'delete_computer',
            arguments: JSON.parse(json) as Record<string, unknown>,
          })
          .catch(
            (err: unknown): CallToolResult => ({
              isError: true,
              content: [{ type: 'text', text: String(err) }],
            }),
          )) as CallToolResult;
        expect(res.isError).toBe(true);
        return textOf(res);
      };
      const other = await refusal('{"computer_id":"vm-1","confirm":true,"zz_proto":1}');
      const proto = await refusal('{"computer_id":"vm-1","confirm":true,"__proto__":1}');
      expect(other).toContain('zz_proto');
      expect(proto).toBe(other.replace('zz_proto', '__proto__'));
      expect(platform.calls).toEqual([]);
    } finally {
      await close();
    }
  });

  it('lists every tool with additionalProperties: false, which is now what it does', async () => {
    const { client, close } = await connect({ modelKey: 'sk-ant-fixture' });
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(
        (tool.inputSchema as { additionalProperties?: unknown }).additionalProperties,
        tool.name,
      ).toBe(false);
    }
    await close();
  });

  // The top level is not the only place a misspelling hides: a nested object
  // — a schedule, a binding, a message — strips the same way unless it is strict.
  it('every object nested in a tool’s arguments is strict too', async () => {
    for (const cfg of [{ modelKey: 'sk-ant-fixture' }, { funded: true }]) {
      const { server, close } = await connect(cfg);
      const loose: string[] = [];
      for (const [name, tool] of Object.entries(registeredOf(server))) {
        const found: [string, z.ZodObject][] = [];
        objectsIn(tool.inputSchema, name, found);
        expect(found.length, name).toBeGreaterThan(0);
        for (const [at, object] of found) {
          if (!(object._zod.def.catchall instanceof z.ZodNever)) loose.push(at);
        }
      }
      expect(loose).toEqual([]);
      await close();
    }
  });
});

describe('oversized arguments', () => {
  let platform: ReturnType<typeof installFakePlatform>;
  beforeEach(() => {
    platform = installFakePlatform();
  });
  afterEach(() => platform.restore());

  // An array whose schema has no maximum is otherwise validated element by
  // element, with an issue kept for every bad one, before the call is refused.
  it('refuses arguments over the element budget before validating them', async () => {
    const { call, close } = await connect({ modelKey: 'sk-ant-fixture' });
    try {
      const messages = Array.from({ length: MAX_TOOL_INPUT_ELEMENTS + 1 }, () => 0);
      const res = await call('run_agent_chat', { messages }).catch(
        (err: unknown): CallToolResult => ({
          isError: true,
          content: [{ type: 'text', text: String(err) }],
        }),
      );
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain(
        `arguments contain more than the maximum of ${MAX_TOOL_INPUT_ELEMENTS} elements`,
      );
      expect(textOf(res)).not.toMatch(/expected object/);
      expect(platform.calls).toEqual([]);
      // Just under the budget is left to the schema, which names what is wrong.
      const under = await call('run_agent_chat', { messages: [0] });
      expect(under.isError).toBe(true);
      expect(textOf(under)).toMatch(/expected object/);
    } finally {
      await close();
    }
  });
});

describe('oversizedArgumentsRefusal', () => {
  const callOf = (args: unknown, name = 'delete_computer') =>
    ({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name, arguments: args },
    }) as JSONRPCMessage;
  const flat = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, 0]));

  // The SDK parses and copies every top-level argument before its own count,
  // so a flat object of many keys has to be refused before it gets there.
  it('refuses a flat object over the budget before the SDK sees it', () => {
    const refusal = oversizedArgumentsRefusal(
      callOf(flat(MAX_TOOL_INPUT_ELEMENTS + 1)),
    ) as unknown as {
      id: number;
      result: CallToolResult;
    };
    expect(refusal.id).toBe(9);
    expect(refusal.result.isError).toBe(true);
    expect(textOf(refusal.result)).toContain(
      `more than the maximum of ${MAX_TOOL_INPUT_ELEMENTS} elements`,
    );
    expect(oversizedArgumentsRefusal(callOf(flat(MAX_TOOL_INPUT_ELEMENTS)))).toBeUndefined();
  });

  it('counts nested elements, and any tool name, but only on tools/call', () => {
    const nested = { a: [Array.from({ length: MAX_TOOL_INPUT_ELEMENTS }, () => ({}))] };
    expect(oversizedArgumentsRefusal(callOf(nested, 'no_such_tool'))).toBeDefined();
    expect(
      oversizedArgumentsRefusal({
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/list',
        params: { arguments: flat(MAX_TOOL_INPUT_ELEMENTS + 1) },
      } as JSONRPCMessage),
    ).toBeUndefined();
  });

  // Only a refusal on the way in can answer this: the SDK would parse the
  // envelope and then say the tool does not exist.
  it('is applied as the message arrives, before the SDK looks the tool up', async () => {
    const { call, close } = await connect();
    try {
      const res = await call('no_such_tool', flat(MAX_TOOL_INPUT_ELEMENTS + 1)).catch(
        (err: unknown): CallToolResult => ({
          isError: true,
          content: [{ type: 'text', text: String(err) }],
        }),
      );
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain(`more than the maximum of ${MAX_TOOL_INPUT_ELEMENTS} elements`);
    } finally {
      await close();
    }
  });

  it('uses the words the SDK uses for the same budget', async () => {
    const { server, close } = await connect();
    try {
      const args = flat(MAX_TOOL_INPUT_ELEMENTS + 1);
      const sdk = server as unknown as {
        validateToolInput(tool: unknown, args: unknown, name: string): Promise<unknown>;
      };
      const thrown = await sdk
        .validateToolInput(registeredOf(server).delete_computer, args, 'delete_computer')
        .then(
          () => 'accepted',
          (err: unknown) => String((err as Error).message),
        );
      const ours = oversizedArgumentsRefusal(callOf(args)) as unknown as { result: CallToolResult };
      expect(textOf(ours.result)).toBe(thrown);
    } finally {
      await close();
    }
  });
});

describe('strictInput', () => {
  it('makes a field map and a stripping object strict', () => {
    for (const schema of [{ a: z.string() }, z.object({ a: z.string() })]) {
      const strict = strictInput('t', schema);
      expect(strict.safeParse({ a: 'x' }).success).toBe(true);
      expect(strict.safeParse({ a: 'x', b: 1 }).success).toBe(false);
    }
    expect(strictInput('t', {}).safeParse({ b: 1 }).success).toBe(false);
  });

  it('keeps a refinement whose object is already strict', () => {
    const refined = z.strictObject({ a: z.number() }).refine((v) => v.a > 0);
    const kept = strictInput('t', refined);
    expect(kept.safeParse({ a: -1 }).success).toBe(false);
    expect(kept.safeParse({ a: 1, b: 1 }).success).toBe(false);
  });

  // A refinement sits on the object itself, so making the object strict has to
  // carry it across rather than rebuild the object from its fields.
  it('makes a refined stripping object strict and keeps the refinement', () => {
    const refined = z.object({ a: z.number() }).refine((v) => v.a > 0, 'a must be positive');
    const strict = strictInput('t', refined);
    expect(strict.safeParse({ a: 1 }).success).toBe(true);
    expect(strict.safeParse({ a: 1, b: 1 }).success).toBe(false);
    const refusal = strict.safeParse({ a: -1 });
    expect(refusal.success).toBe(false);
    expect(refusal.error?.issues.map((i) => i.message)).toEqual(['a must be positive']);
  });

  it('refuses at registration what it cannot make strict', () => {
    expect(() => strictInput('t', undefined)).toThrow(/no input schema/);
    expect(() => strictInput('t', z.looseObject({}))).toThrow(/through/);
    expect(() => strictInput('t', z.object({}).catchall(z.string()))).toThrow(/catch-all/);
    expect(() => strictInput('t', z.string())).toThrow(/strict object/);
  });
});
