import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { strictInput } from '../src/server.js';
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
function objectsIn(schema: unknown, at: string, out: [string, z.AnyZodObject][]): void {
  if (schema instanceof z.ZodObject) {
    out.push([at, schema]);
    for (const [key, field] of Object.entries(schema.shape as Record<string, unknown>))
      objectsIn(field, `${at}.${key}`, out);
  } else if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault ||
    schema instanceof z.ZodReadonly ||
    schema instanceof z.ZodCatch
  ) {
    objectsIn(schema._def.innerType, at, out);
  } else if (schema instanceof z.ZodEffects) {
    objectsIn(schema.innerType(), at, out);
  } else if (schema instanceof z.ZodBranded) {
    objectsIn(schema.unwrap(), at, out);
  } else if (schema instanceof z.ZodPipeline) {
    objectsIn(schema._def.in, at, out);
  } else if (schema instanceof z.ZodArray) {
    objectsIn(schema.element, `${at}[]`, out);
  } else if (schema instanceof z.ZodUnion || schema instanceof z.ZodDiscriminatedUnion) {
    for (const [i, option] of (schema.options as unknown[]).entries())
      objectsIn(option, `${at}|${i}`, out);
  } else if (schema instanceof z.ZodIntersection) {
    objectsIn(schema._def.left, at, out);
    objectsIn(schema._def.right, at, out);
  } else if (schema instanceof z.ZodRecord) {
    objectsIn(schema.valueSchema, `${at}{}`, out);
  } else if (schema instanceof z.ZodTuple) {
    for (const [i, item] of (schema.items as unknown[]).entries())
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
            expect(textOf(res), name).toMatch(/Unrecognized key/);
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
      expect(textOf(res)).toContain("Unrecognized key(s) in object: '__proto__'");
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
        const found: [string, z.AnyZodObject][] = [];
        objectsIn(tool.inputSchema, name, found);
        expect(found.length, name).toBeGreaterThan(0);
        for (const [at, object] of found) {
          if (object._def.unknownKeys !== 'strict') loose.push(at);
        }
      }
      expect(loose).toEqual([]);
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
    const refined = z
      .object({ a: z.number() })
      .strict()
      .refine((v) => v.a > 0);
    const kept = strictInput('t', refined);
    expect(kept.safeParse({ a: -1 }).success).toBe(false);
    expect(kept.safeParse({ a: 1, b: 1 }).success).toBe(false);
  });

  it('refuses at registration what it cannot make strict', () => {
    expect(() => strictInput('t', undefined)).toThrow(/no input schema/);
    expect(() => strictInput('t', z.object({}).passthrough())).toThrow(/through/);
    expect(() => strictInput('t', z.object({}).catchall(z.string()))).toThrow(/catch-all/);
    expect(() =>
      strictInput(
        't',
        z.object({ a: z.number() }).refine(() => true),
      ),
    ).toThrow(/strict object/);
    expect(() => strictInput('t', z.string())).toThrow(/strict object/);
  });
});
