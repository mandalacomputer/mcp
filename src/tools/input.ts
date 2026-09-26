import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ConflictError, reasonKind } from '../errors.js';
import {
  apiErrorMessage,
  failed,
  guarded,
  INLINE_IMAGE_TYPES,
  image,
  isInlineImage,
  json,
  MAX_INLINE_IMAGE_BYTES,
  refused,
  said,
} from '../format.js';
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

/**
 * A refused capture, and the one other question this tool can ask.
 *
 * The platform's own sentence first and whole — it is the half that says which
 * computer and what state it is in — and the platform's classification with it,
 * since `failed` is what composes both. What this adds is the thing neither can
 * know: that this tool has an argument which asks for something else, and that
 * the something else may be answerable when a new capture is not.
 *
 * Offered as a FALLBACK and not as a promise, which is the whole of the care
 * needed here (Codex review). Two different refusals reach this, and it cannot
 * tell them apart: a computer that is asleep has nothing to capture from, while
 * a computer whose agent is busy for an instant has and will answer the very
 * same call moments later. `fresh: false` only permits the cache — it does not
 * establish that anything is in it — so a sentence guaranteeing a frame sends a
 * caller from a refusal that clears by itself to one that does not clear at all.
 * Hence: the platform's sentence is pointed back at, the fallback is conditional,
 * and what the frame would MEAN is stated, because a saved frame read as the
 * present is a worse answer than no frame.
 *
 * And it promises nothing about the OTHER branch either (Codex review). The
 * platform's classification says the thing in the way can finish; it does not
 * say the computer will then be in a state that can be photographed — a disk
 * still being built clears into a computer that is merely stopped, and the next
 * look is a 400 rather than a picture. So the retry is named as the first thing
 * to try, and the caller is told what it is not.
 */
const cachedFrameOffered = (err: ConflictError, shaped: string[] = []): CallToolResult => {
  const sentence = failed(err)
    .content.map((c) => ('text' in c ? c.text : ''))
    .join('\n');
  // A shaped request has one more condition on the fallback: the saved frame
  // of a suspended computer is a single JPEG that cannot be cropped, scaled,
  // re-encoded as PNG or given a quality, and the platform refuses those on
  // it too. Said here, or fresh: false is advice that meets the same wall.
  //
  // But only where the refusal can BE a suspended computer's. A word that
  // clears by itself (contention, starting) usually comes from a computer that
  // is up, and on one of those fresh: false is served from the frame cache and
  // shaped like any other capture — so telling that caller to drop a crop
  // costs them the crop for nothing. Usually, not always: a suspended
  // computer's saved desktop is read under its lifecycle lock, and a busy lock
  // is contention too ("this computer's saved desktop is being updated"). So a
  // clearing word keeps the sentence where the platform's own sentence speaks
  // of the saved desktop, or of a suspend. The same busy lock is also a resume
  // under way, which ends in a computer that can shape a frame, and the two
  // read alike; hence "while it stays suspended", and the retry named first.
  //
  // "suspend" is there in case the wording moves, not because a screenshot
  // meets it today: a computer part way INTO a suspend has no saved desktop
  // yet, so its screenshot takes the running path and is refused as a busy
  // screen ("this computer's screen is busy with another operation"), which
  // names neither. That one gets no caveat, on purpose: the same sentence is
  // every running computer's busy screen, where the caveat would cost the crop
  // for nothing. It fails safe, as does any rewording: the retry named first
  // reaches the suspended computer and is refused with the caveat, and a
  // shaped fresh: false is refused with shapeRefused's full advice.
  //
  // And conditional even then: `unavailable` is also a computer that is
  // merely stopped, and an unclassified 409 could be anything, so the
  // platform's sentence is what says which it is.
  const suspendedWords = /suspend|saved desktop/i.test(apiErrorMessage(err));
  const without =
    shaped.length && (reasonKind(err.reason) !== 'clears' || suspendedWords)
      ? ` If the sentence above says the computer is suspended or being suspended, or speaks of its saved ` +
        `desktop, its saved frame cannot be shaped while it stays suspended, so fresh: false has to go ` +
        `without ${shaped.join(', ')} as well, or it is refused for that instead.`
      : '';
  return refused(
    `${sentence}\n\nThat was a request for a NEW capture. Read the sentence above before anything else: where ` +
      `it says this is worth another attempt, sending the same call again in a moment is the first thing to ` +
      `try — it is not a promise that the capture then works, since a computer that turns out not to be ` +
      `running needs starting rather than another look. The other option is fresh: false, which asks for the ` +
      `last frame the platform saved rather than a new one and so needs nothing captured; it is refused in ` +
      `the same way when there is no saved frame to serve, so it is a fallback and not a guarantee either.` +
      `${without} ` +
      `Whatever comes back is the screen as it was when that frame was taken and not the screen now: it ` +
      `cannot show the result of anything sent since.`,
  );
};

/**
 * The four things that shape a screenshot besides a width, and whether this
 * call asked for any of them that a suspended computer cannot answer.
 *
 * A suspended computer has one saved JPEG of its desktop, and the platform
 * refuses a crop, a scale, a PNG or a quality on it with 409 `unavailable`
 * (only a width and `format: jpeg` are answered with the saved picture). So
 * this is the question that decides whether `fresh: false` is still a way out.
 */
type Shape = {
  region?: { x: number; y: number; width: number; height: number };
  scale?: number;
  format?: 'png' | 'jpeg';
  quality?: number;
};
const unshapeable = (s: Shape): string[] =>
  [
    s.region && 'region',
    s.scale !== undefined && 'scale',
    s.format === 'png' && 'format: png',
    s.quality !== undefined && 'quality',
  ].filter((v): v is string => typeof v === 'string');

/**
 * A refused request for the saved picture that also asked for a shape.
 *
 * Reached on a 409 `unavailable` to a call with fresh off and a shape, and
 * that is three different computers which this cannot tell apart: a suspended
 * one that has its saved JPEG and refuses to shape it, a suspended one with no
 * saved picture at all (the platform names that before it looks at the shape),
 * and one that is simply not running, which has neither. Dropping the shape is
 * a way out of the first only — offered as such, the second and third would be
 * sent round to a retry that is refused again. So the platform's sentence
 * first, as everywhere, since it is the half that says which of the three this
 * is; then start_computer, which answers all three; then the unshaped retry,
 * under the one condition that makes it worth sending.
 */
const shapeRefused = (err: ConflictError, asked: string[]): CallToolResult => {
  const sentence = failed(err)
    .content.map((c) => ('text' in c ? c.text : ''))
    .join('\n');
  return refused(
    `${sentence}\n\nThis call asked for ${asked.join(', ')}, which only a running computer's screen can ` +
      `answer: a suspended computer keeps at most one JPEG of its desktop, saved when it suspended, and that ` +
      `cannot be cropped, scaled, re-encoded as PNG or given a quality. start_computer is the way to a screen ` +
      `that can be shaped. Only where the sentence above says the computer has its saved desktop picture is ` +
      `there one to fall back on: ask again with fresh: false and without ${asked.join(', ')} for it, which is the screen ` +
      `as it was when the computer suspended and not the screen now. Where it says there is no saved desktop, ` +
      `or that the computer is not running, dropping them is refused the same way and only a start helps.`,
  );
};

/**
 * What the coordinates in a shaped picture mean, as the one sentence a model
 * needs before it clicks on anything in it.
 *
 * A crop or a scale puts the picture in its OWN pixel space, and click, drag
 * and scroll take SCREEN pixels. The mapping is arithmetic the model can do,
 * but only if it is told the numbers, so they are stated rather than implied.
 * A width is turned into its factor here the way the platform turns it: at
 * least 64 pixels, never wider than what is being shrunk.
 */
const shapeNote = (width: number | undefined, s: Shape): string | undefined => {
  const r = s.region;
  const source = r?.width;
  let factor = s.scale;
  if (width !== undefined) {
    factor = source === undefined ? undefined : Math.min(Math.max(width, 64), source) / source;
  }
  if (!r) {
    if (width !== undefined)
      return `(scaled to ${width}px wide — click using full-size coordinates)`;
    if (factor === undefined || factor === 1) return undefined;
    return `(scaled by ${factor}: to click on something in this picture, divide its position by ${factor})`;
  }
  const at = `${r.x},${r.y},${r.width},${r.height}`;
  if (factor === undefined || factor === 1) {
    return `(the region ${at} of the screen: to click on something in this picture, add ${r.x} to its x and ${r.y} to its y)`;
  }
  const f = Number(factor.toPrecision(6));
  return `(the region ${at} of the screen, scaled by ${f}: to click on something in this picture, divide its position by ${f}, then add ${r.x} to x and ${r.y} to y)`;
};

/** The longest text one `type` takes, in characters. */
export const TYPE_TEXT_MAX_CHARS = 400;

/** The platform's words for how a `type` went, as the clause each means. */
const TYPE_MECHANISMS = {
  physical: 'as US-layout key presses',
  unicode: 'by GTK Unicode composition',
  mixed: 'in order, ASCII as key presses and the rest by GTK Unicode composition',
} as const;

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
            'Skip the platform\'s frame cache, which serves any capture under 1.5s old — up to 30s old while the computer is busy with another operation. True by default: after a click, a cached frame can predate the action entirely, and a model reading it concludes the click missed and clicks again. A capture needs a computer that is awake, so on a suspended one this is refused rather than answered — pass false to ask for the last saved frame instead, which is refused in turn when there is no saved frame to serve. A saved frame answers "what was on the screen" and cannot answer "did my click land".',
          ),
        region: z
          .object({
            x: z.number().int().min(0),
            y: z.number().int().min(0),
            width: z.number().int().min(1),
            height: z.number().int().min(1),
          })
          .optional()
          .describe(
            'Crop to this rectangle of the screen. x, y, width and height are SCREEN pixels, the ones click takes, measured before any scaling. It has to lie inside the screen: one that reaches past an edge is refused with the screen size rather than clipped. The picture that comes back starts at (0, 0), so add x and y to a position in it before clicking there.',
          ),
        scale: z
          .number()
          .gt(0)
          .max(1)
          .optional()
          .describe(
            'Shrink the picture by this factor, greater than 0 and at most 1: 0.5 halves both sides, a quarter of the pixels. Not with width. Divide a position in the smaller picture by this before clicking there.',
          ),
        format: z
          .enum(['png', 'jpeg'])
          .optional()
          .describe(
            'png (the default) or jpeg (the default with width). A JPEG is much smaller for the same picture.',
          ),
        quality: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe(
            'JPEG quality, 1 to 100 (72 when not given). A JPEG only: pass format: jpeg with it.',
          ),
      },
      annotations: { readOnlyHint: true },
    },
    ({ computer_id, width, fresh, region, scale, format, quality }, extra) =>
      guarded(async () => {
        const shape: Shape = { region, scale, format, quality };
        // The two refusals the platform would make that are knowable from the
        // arguments alone, made here so the answer names this tool's own
        // parameters and costs no round trip. Everything else about a shape —
        // chiefly whether a region fits the screen — is the platform's to say.
        if (width !== undefined && scale !== undefined) {
          return refused(
            'Give width or scale, not both: each sets the size of the picture. Nothing was sent.',
          );
        }
        if (quality !== undefined && (format ?? (width === undefined ? 'png' : 'jpeg')) === 'png') {
          return refused(
            'quality applies to a JPEG only, and this picture would be a PNG. Add format: jpeg (or drop quality). Nothing was sent.',
          );
        }
        const id = session.resolve(computer_id);
        let shot: Awaited<ReturnType<typeof session.api.bytes>>;
        try {
          shot = await session.api.with(extra.signal).bytes(
            'GET',
            P.computerAction(id, 'screenshot'),
            {
              query: {
                w: width,
                fresh: fresh ? 1 : undefined,
                region: region && `${region.x},${region.y},${region.width},${region.height}`,
                scale,
                format,
                quality,
              },
            },
            MAX_INLINE_IMAGE_BYTES,
          );
        } catch (err) {
          // The refusal whose next step is a PARAMETER, caught here for the
          // reason `backgroundFull` is caught in exec: the answer names one of
          // this tool's own arguments, and the error classes are shared with
          // every embedder and with two other clients.
          //
          // Only when this call asked for a capture, which is the only way the
          // refusal can be about asking for one. A model that meets a bare 409
          // here has nothing to try, and the thing it does instead is ask again
          // — a loop over a computer that cannot answer it.
          //
          // And a shaped picture: a suspended computer refuses a crop, a scale,
          // a PNG or a quality even with fresh off, so offering fresh: false
          // alone would send the caller into the same wall. Checked first, and
          // for fresh too, since the platform names the capture before the
          // shape and the shape would be the next refusal.
          const asked = unshapeable(shape);
          if (
            err instanceof ConflictError &&
            asked.length > 0 &&
            (fresh || err.reason === 'unavailable')
          ) {
            return fresh ? cachedFrameOffered(err, asked) : shapeRefused(err, asked);
          }
          if (fresh && err instanceof ConflictError) return cachedFrameOffered(err);
          throw err;
        }
        // The bound `read_file` observes, observed here too. A 3840x2160 capture
        // of a dense screen is the case it exists for: refused with its size and
        // the parameter that fixes it, rather than turned into ~85 MB of base64
        // in a context that then has room for nothing else.
        if (shot.truncated) {
          const size =
            shot.totalBytes === undefined ? `more than ${shot.bytes.length}` : shot.totalBytes;
          // Every argument that makes the picture smaller, not only the
          // oldest: a crop is often the better answer (the part of the screen
          // in question, at full detail), and a JPEG shrinks a dense screen
          // several times over at the same size. The note on the picture that
          // comes back says how its positions map to the screen, so this does
          // not have to.
          return refused(
            `That screenshot is ${size} bytes, over the ${MAX_INLINE_IMAGE_BYTES}-byte inline limit. An image cannot be truncated, so nothing was returned. Ask again for a smaller picture: a width (e.g. width: 1280) or a scale (e.g. scale: 0.5), format: jpeg, or a region of the screen — any of them, or a region with one of the others. The note on the picture that comes back says how its positions map to the screen click takes.`,
          );
        }
        if (shot.bytes.length === 0) {
          return refused(
            `That screenshot came back empty (${shot.contentType}). Nothing was returned rather than passing zero bytes off as a picture.`,
          );
        }
        // What came back has to actually be an image. A captive portal or a
        // misconfigured proxy answering 200 with an HTML page is the case this
        // exists for: without it that page is handed over as image content
        // typed `text/html`, and the model is left staring at a picture that
        // will not decode with nothing saying why.
        //
        // The RASTER allowlist, not `startsWith('image/')`, which is what
        // read_file has always used and what this path should have used with
        // it. `image/*` admits `image/svg+xml` — XML, which a client that
        // renders inline image content can be made to execute script from. The
        // interloper this check exists to catch is precisely the party that
        // would choose that type, so the loose spelling was widest open in the
        // one case it was written for.
        if (!isInlineImage(shot.contentType)) {
          return refused(
            `That screenshot came back as ${shot.contentType}, not one of the image types this can hand over (${[...INLINE_IMAGE_TYPES].join(', ')}) — ${shot.bytes.length} bytes. Something between here and the guest answered in place of the capture; nothing was returned rather than passing it off as a picture.`,
          );
        }
        const shaped = shapeNote(width, shape);
        const scaled = shaped ? ` ${shaped}` : '';
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
        'Type a string into whatever has keyboard focus: literal text, 1 to 400 characters. For Enter, Tab or a shortcut, use press_key. Plain ASCII is typed as US-layout key events, about 12 ms a character, so 400 characters take about five seconds. Text containing any other character — accents, CJK, emoji — is typed WHOLE and in order by one guest helper: its ASCII as the same key presses and the rest by GTK Unicode composition. That works in Chromium (GTK3) and Xfce Terminal on a Linux X11 desktop; Firefox, GTK4 apps, native Wayland apps and Windows are unsupported for non-ASCII text, and such text is checked and refused before any key is pressed. Tab and newline are sent as keys and CRLF as one Return; a bare CR and other control characters are refused. The answer says which way it was typed. It confirms the keys were sent, not that the application accepted them: check with a screenshot before relying on it.',
      inputSchema: {
        ...idArg,
        text: z
          .string()
          .min(1, 'text must not be empty')
          .refine((t) => [...t].length <= TYPE_TEXT_MAX_CHARS, {
            message: `text must be at most ${TYPE_TEXT_MAX_CHARS} characters; type longer text in pieces, or write it to a file`,
          })
          .describe(
            `The characters to type, at most ${TYPE_TEXT_MAX_CHARS}. Longer text goes in several calls, or through write_file or write_clipboard.`,
          ),
      },
    },
    ({ computer_id, text }, extra) =>
      guarded(async () => {
        const answer = await post(computer_id, P.typeBody(text), extra.signal);
        // Code points, not `.length`. A string's length is its UTF-16 code
        // units, so an emoji is two and "Typed 2 character(s)" is a number this
        // server made up about a single keystroke's worth of text — a number a
        // model may repeat to whoever asked. The neighbours here already count
        // in the unit that means something rather than in units of storage:
        // `hasUnpairedSurrogate` works in code points and `clipboardBody`
        // accounts in bytes.
        const typed = [...text].length;
        // How it was typed (OPL-4996), when the platform said so in a word this
        // version knows. An unknown word, or none, says nothing rather than
        // being guessed at.
        const mechanism =
          answer && typeof answer === 'object'
            ? (answer as { mechanism?: unknown }).mechanism
            : undefined;
        const how =
          typeof mechanism === 'string' && Object.hasOwn(TYPE_MECHANISMS, mechanism)
            ? ` ${TYPE_MECHANISMS[mechanism as keyof typeof TYPE_MECHANISMS]}`
            : '';
        return said(
          `Typed ${typed} character(s)${how}. That confirms the keys were sent, not that the application accepted the text: check with a screenshot before relying on it.`,
        );
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
          .array(z.string().trim().min(1, 'Key names must not be empty.'))
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
        'Where the pointer was last put. `known` is false on a computer nothing has moved it on yet — the guest cannot be asked, so there is no coordinate to report and a confident 0,0 would be a wrong answer dressed as a right one. This reads a coordinate but reaches the computer to do it: a suspended one is resumed to answer, and that resume is charged. read_clipboard, by contrast, refuses a suspended computer rather than starting it.',
      inputSchema: { ...idArg },
      // Deliberately not readOnlyHint, for the reason exec_poll is not. It reads
      // as one — nothing is created, nothing is destroyed, and the answer is a
      // coordinate — but it POSTs the input drive route, which resumes a
      // suspended computer and bills for the time, as write_clipboard's
      // description says in as many words. Clients treat the hint as licence to
      // call without asking, so the annotation is what decides whether anyone is
      // asked before a read starts a machine. `screenshot` above keeps its hint
      // because it is a GET and does no such thing.
      //
      // The other two flags are set rather than left to default, because both
      // defaults are wrong once readOnlyHint is false: the spec defaults
      // destructiveHint to TRUE and idempotentHint to FALSE. Dropping the
      // object outright would trade an under-warning for an over-warning — a
      // host asking whether it may perform destructive updates in order to read
      // a pointer coordinate — and would tell a host not to retry a read it can
      // safely retry. `create_computer` sets destructiveHint for this reason,
      // and idempotentHint is set deliberately in computers.ts, snapshots.ts
      // and templates.ts.
      annotations: { destructiveHint: false, idempotentHint: true },
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
