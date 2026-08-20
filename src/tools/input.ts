import { z } from 'zod';
import { guarded, image, json, MAX_INLINE_IMAGE_BYTES, refused, said } from '../format.js';
import * as P from '../paths.js';
import type { Registrar } from './types.js';

const idArg = {
  computer_id: z
    .string()
    .optional()
    .describe('Which computer. Defaults to the one selected with use_computer.'),
};

const modifiers = z
  .array(z.enum(['shift', 'ctrl', 'alt', 'super', 'meta', 'cmd']))
  .optional()
  .describe('Keys held down for the duration of the action.');

/**
 * A coordinate pair that is genuinely optional.
 *
 * Leaving both out means "where the pointer already is", which the platform
 * carries all the way down and which is a different request from (0, 0) — the
 * corner of the screen. Said in the description because a model reading
 * `x?: number` will otherwise fill it with a zero to be helpful.
 */
const point = {
  x: z
    .number()
    .int()
    .optional()
    .describe(
      'Leave x and y out to act where the pointer already is. Both or neither — half a coordinate is refused rather than completed with a zero.',
    ),
  y: z.number().int().optional(),
};

export const registerInput: Registrar = (server, session) => {
  const post = (
    computerId: string | undefined,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ) =>
    session.api
      .with(signal)
      .send('POST', P.computerAction(session.resolve(computerId), 'input'), { body });

  server.registerTool(
    'screenshot',
    {
      title: 'Screenshot the desktop',
      description:
        'A picture of what is on the screen right now, returned as an image. Coordinates in this picture are the ones click, drag and scroll take.',
      inputSchema: {
        ...idArg,
        width: z
          .number()
          .int()
          .min(64)
          .max(3840)
          .optional()
          .describe(
            'Scale the image down to this width before returning it. The coordinates you click with are still the full-size ones, so only use this to save context, and do your pointing on a full-size frame.',
          ),
        fresh: z
          .boolean()
          .default(true)
          .describe(
            "Skip the platform's frame cache, which serves any capture under 1.5s old. True by default: after a click, a cached frame can predate the action entirely, and a model reading it concludes the click missed and clicks again.",
          ),
      },
      annotations: { readOnlyHint: true },
    },
    ({ computer_id, width, fresh }, extra) =>
      guarded(async () => {
        const id = session.resolve(computer_id);
        const shot = await session.api.with(extra.signal).bytes(
          'GET',
          P.computerAction(id, 'screenshot'),
          {
            query: { w: width, fresh: fresh ? 1 : undefined },
          },
          MAX_INLINE_IMAGE_BYTES,
        );
        // The bound `read_file` observes, observed here too. A 3840x2160 capture
        // of a dense screen is the case it exists for: refused with its size and
        // the parameter that fixes it, rather than turned into ~85 MB of base64
        // in a context that then has room for nothing else.
        if (shot.truncated) {
          const size =
            shot.totalBytes === undefined ? `more than ${shot.bytes.length}` : shot.totalBytes;
          return refused(
            `That screenshot is ${size} bytes, over the ${MAX_INLINE_IMAGE_BYTES}-byte inline limit. An image cannot be truncated, so nothing was returned. Ask again with a width — e.g. width: 1280 — and click using full-size coordinates.`,
          );
        }
        // What came back has to actually be an image. A captive portal or a
        // misconfigured proxy answering 200 with an HTML page is the case this
        // exists for: without it that page is handed over as image content
        // typed `text/html`, and the model is left staring at a picture that
        // will not decode with nothing saying why. `read_file` guards the same
        // shape; this is the other path that emits an image.
        if (!shot.contentType.startsWith('image/')) {
          return refused(
            `That screenshot came back as ${shot.contentType}, not an image (${shot.bytes.length} bytes). Something between here and the guest answered in place of the capture; nothing was returned rather than passing it off as a picture.`,
          );
        }
        const scaled = width
          ? ` (scaled to ${width}px wide — click using full-size coordinates)`
          : '';
        // Only for the bound computer. session.screen is definitionally the
        // bound machine's geometry — noteResolution refuses to update it for
        // any other id — so printing it beside a screenshot of a computer named
        // explicitly would state the wrong coordinate space, in the one tool
        // whose whole job is to establish that space.
        const screen =
          id === session.current && session.screen ? `Screen is ${session.screen}.` : '';
        return image(shot.bytes, shot.contentType, `${screen}${scaled}`.trim() || undefined);
      }),
  );

  server.registerTool(
    'click',
    {
      title: 'Click',
      description:
        'Click the mouse. Left button once by default. Take a screenshot afterwards to see what happened — the desktop does not report back on its own.',
      inputSchema: {
        ...idArg,
        ...point,
        button: z.enum(['left', 'right', 'middle']).default('left'),
        count: z
          .number()
          .int()
          .min(1)
          .max(3)
          .default(1)
          .describe('1, 2 for a double click, 3 for a triple click. Left button only.'),
        modifiers,
      },
    },
    ({ computer_id, x, y, button, count, modifiers: mods }, extra) =>
      guarded(async () => {
        const action = clickAction(button, count);
        if (!action) {
          return refused(
            `A ${count}-times ${button} click is not a thing the desktop can be asked for; only the left button doubles and triples.`,
          );
        }
        await post(computer_id, P.clickBody(action, x, y, mods ?? []), extra.signal);
        const where = x === undefined ? 'where the pointer was' : `at ${x},${y}`;
        return said(`${action} ${where}. Screenshot to see the result.`);
      }),
  );

  server.registerTool(
    'type_text',
    {
      title: 'Type text',
      description:
        'Type a string into whatever has keyboard focus. This is literal text — for Enter, Tab, or a shortcut, use press_key.',
      inputSchema: { ...idArg, text: z.string().describe('The characters to type.') },
    },
    ({ computer_id, text }, extra) =>
      guarded(async () => {
        await post(computer_id, P.typeBody(text), extra.signal);
        return said(`Typed ${text.length} character(s).`);
      }),
  );

  server.registerTool(
    'press_key',
    {
      title: 'Press a key or a chord',
      description:
        'Press named keys — "Return", "Tab", "Escape", "Page_Down", or a chord like ["ctrl","c"]. X keysym names, so "Return" rather than "Enter".',
      inputSchema: {
        ...idArg,
        keys: z
          .array(z.string())
          .min(1)
          .describe('One key, or several for a chord pressed together.'),
        hold_seconds: z
          .number()
          .positive()
          .max(30)
          .optional()
          .describe('Hold the keys down this long instead of tapping them. Capped at 30s.'),
      },
    },
    ({ computer_id, keys, hold_seconds }, extra) =>
      guarded(async () => {
        await post(computer_id, P.keyBody(keys, hold_seconds), extra.signal);
        return said(
          hold_seconds
            ? `Held ${keys.join('+')} for ${hold_seconds}s.`
            : `Pressed ${keys.join('+')}.`,
        );
      }),
  );

  server.registerTool(
    'scroll',
    {
      title: 'Scroll',
      description:
        'Turn the wheel. With no coordinate it scrolls whatever is under the pointer; with one it scrolls what is at that point.',
      inputSchema: {
        ...idArg,
        direction: z.enum(P.SCROLL_DIRECTIONS),
        amount: z.number().int().min(1).max(50).default(3).describe('Wheel clicks.'),
        ...point,
        modifiers,
      },
    },
    ({ computer_id, direction, amount, x, y, modifiers: mods }, extra) =>
      guarded(async () => {
        await post(
          computer_id,
          P.scrollBody({ direction, amount, x, y, modifiers: mods }),
          extra.signal,
        );
        return said(`Scrolled ${direction} by ${amount}.`);
      }),
  );

  server.registerTool(
    'drag',
    {
      title: 'Drag',
      description:
        'Press, move and release as one gesture — for selecting text, moving a file, or dragging a slider. Not the same as two clicks.',
      inputSchema: {
        ...idArg,
        to_x: z.number().int(),
        to_y: z.number().int(),
        from_x: z
          .number()
          .int()
          .optional()
          .describe(
            'Where to start. Both from_x and from_y, or neither — half of an origin is refused rather than ignored.',
          ),
        from_y: z.number().int().optional(),
      },
    },
    ({ computer_id, to_x, to_y, from_x, from_y }, extra) =>
      guarded(async () => {
        await post(computer_id, P.dragBody(to_x, to_y, from_x, from_y), extra.signal);
        const from = from_x === undefined ? 'the pointer' : `${from_x},${from_y}`;
        return said(`Dragged from ${from} to ${to_x},${to_y}.`);
      }),
  );

  server.registerTool(
    'move_mouse',
    {
      title: 'Move the pointer',
      description: 'Move the pointer without clicking — for hovering over a menu or a tooltip.',
      inputSchema: { ...idArg, x: z.number().int(), y: z.number().int() },
    },
    ({ computer_id, x, y }, extra) =>
      guarded(async () => {
        await post(computer_id, P.pointerBody('mouse_move', x, y), extra.signal);
        return said(`Pointer at ${x},${y}.`);
      }),
  );

  server.registerTool(
    'mouse_button',
    {
      title: 'Hold or release the mouse button',
      description:
        'The two halves of a click, for gestures drag cannot express — a lasso across several stops, or a press held while the keyboard is used.',
      inputSchema: {
        ...idArg,
        state: z.enum(['down', 'up']),
        ...point,
      },
    },
    ({ computer_id, state, x, y }, extra) =>
      guarded(async () => {
        await post(computer_id, P.buttonBody(`left_mouse_${state}`, x, y), extra.signal);
        return said(`Left button ${state}${x === undefined ? '' : ` at ${x},${y}`}.`);
      }),
  );

  server.registerTool(
    'cursor_position',
    {
      title: 'Where is the pointer',
      description:
        'Where the pointer was last put. `known` is false on a computer nothing has moved it on yet — the guest cannot be asked, so there is no coordinate to report and a confident 0,0 would be a wrong answer dressed as a right one.',
      inputSchema: { ...idArg },
      annotations: { readOnlyHint: true },
    },
    ({ computer_id }, extra) =>
      guarded(async () =>
        // `json`, not the shared `post`: every other action here throws away
        // the answer, but this one IS the answer. `send` may legitimately
        // resolve to undefined, and `JSON.stringify(undefined)` is undefined
        // rather than a string — which is `{ type: 'text', text: undefined }`,
        // an invalid result the client rejects for the whole call while naming
        // nothing. A route that must answer says so by using `json`.
        json(
          await session.api
            .with(extra.signal)
            .json('POST', P.computerAction(session.resolve(computer_id), 'input'), {
              body: P.cursorBody(),
            }),
        ),
      ),
  );

  server.registerTool(
    'wait',
    {
      title: 'Wait',
      description:
        'Pause before looking again — for a page that is still painting or an application that is still starting. Capped at 30 seconds, because a wait here is a held HTTP request and a longer one would not return, it would fail.',
      inputSchema: {
        ...idArg,
        seconds: z.number().positive().max(30).default(2),
      },
    },
    ({ computer_id, seconds }, extra) =>
      guarded(async () => {
        await post(computer_id, P.waitBody(seconds), extra.signal);
        return said(`Waited ${seconds}s.`);
      }),
  );
};

/** The platform's verb for a button and a repeat count, or nothing if there isn't one. */
function clickAction(button: string, count: number): string | undefined {
  if (count === 1) return `${button}_click`;
  if (button !== 'left') return undefined;
  return count === 2 ? 'double_click' : 'triple_click';
}
