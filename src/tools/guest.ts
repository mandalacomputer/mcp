import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Bytes } from '../api.js';
import { RangeNotSatisfiableError } from '../errors.js';
import { guarded, image, json, MAX_INLINE_IMAGE_BYTES, refused, said, text } from '../format.js';
import * as P from '../paths.js';
import type { Registrar } from './types.js';

const idArg = {
  computer_id: z
    .string()
    .optional()
    .describe('Which computer. Defaults to the one selected with use_computer.'),
};

const pidSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)
  .describe('The positive, safe-integer pid exec returned.');

/**
 * How much of a file this server will put into a model's context.
 *
 * The platform moves up to 64 MiB in one request, which is right for artifacts
 * and catastrophic for a context window. A read that came back at that size
 * would not be a large answer, it would be the end of the conversation — so the
 * read is bounded here, says how much it kept, and says where to ask for the
 * next piece.
 */
const MAX_INLINE_BYTES = 256 * 1024;

/**
 * How large a window a read asks the platform for.
 *
 * The most this tool could ever hand back, which is the image cap rather than
 * the text one: the content type is not known until the response arrives, and a
 * window sized for text would cut every image over 256 KiB into bytes that will
 * not decode. Text is cut to MAX_INLINE_BYTES on arrival, and the rest of the
 * body is cancelled rather than read.
 */
const MAX_WINDOW_BYTES = MAX_INLINE_IMAGE_BYTES;

/**
 * Raster types that MCP image content can carry safely.
 *
 * `image/*` includes `image/svg+xml`, and a client that inlines that MIME as
 * a picture can execute script from a guest file. SVG is XML; it goes through
 * the text / base64 path like any other non-raster file.
 */
const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function isInlineImage(contentType: string): boolean {
  return INLINE_IMAGE_TYPES.has(contentType);
}

const absolutePath = (what: string) =>
  z
    .string()
    .startsWith('/', `${what} must be an absolute path starting with /`)
    .describe(`Absolute path ${what === 'cwd' ? 'to run in' : 'inside the guest'}.`);

export const registerGuest: Registrar = (server, session) => {
  server.registerTool(
    'exec',
    {
      title: 'Run a command in the guest',
      description:
        'Run a shell command inside the computer. Runs as root with no display by default — anything that opens a window needs desktop: true, anything slower than a few seconds needs background: true, and anything that needs an environment variable takes env rather than an assignment written into the command. Against the hosted platform, waiting here is capped at about two minutes by a proxy in front of it, not by timeout_s.',
      inputSchema: {
        ...idArg,
        command: z.string().describe('A shell command line.'),
        timeout_s: z
          .number()
          .int()
          .min(1)
          .max(300)
          .default(30)
          .describe(
            'How long to wait for it to exit. A command that outlives this keeps running inside the guest — your deadline passing means you stopped waiting, not that the work was destroyed. Against the hosted app.mandala.computer, do not reach past about 120 here: a proxy in front of the platform abandons the request at roughly two minutes and answers 524 whatever this says, so a larger number buys no time and only delays the failure. Use background: true for anything slower. The range above 120 is for a self-hosted MANDALA_BASE_URL reached without that proxy.',
          ),
        desktop: z
          .boolean()
          .default(false)
          .describe(
            'Run inside the logged-in desktop session instead of as root with no display. Required for anything with a window: the guest agent has no DISPLAY, so a GUI app started without this cannot draw. Linux only.',
          ),
        background: z
          .boolean()
          .default(false)
          .describe(
            'Return a handle immediately instead of waiting. Use for builds, installs, test suites and servers, then read output with exec_poll. Strictly better than backgrounding with "&", which throws away the exit code and the output.',
          ),
        cwd: absolutePath('cwd').optional(),
        env: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            'Environment for this command, as {NAME: "value"}. Use it instead of writing FOO=bar in front of the command: a prefix assignment is shell syntax, so a value holding a space, a quote, a newline or a $ has to be quoted correctly by you and is silently truncated or re-parsed when it is not, while this reaches the process whole and unquoted. It also keeps a secret out of the command line, which is world-readable in the guest\'s ps and, for a background command, comes back to you inside every exec_poll answer. The variables are added on top of the guest\'s login profile rather than replacing it, so PATH and the rest are still there, and they apply to this command only — including with desktop: true. Names must not be empty or contain "=".',
          ),
      },
    },
    ({ computer_id, command, timeout_s, desktop, background, cwd, env }, extra) =>
      guarded(async () => {
        const id = session.resolve(computer_id);
        const res = await session.api
          .with(extra.signal)
          .json<Record<string, unknown>>('POST', P.computerAction(id, 'exec'), {
            body: P.execBody({ command, timeout_s, desktop, background, cwd, env }),
          });
        if (background) {
          // A pid is the whole product of a background exec: without one there
          // is nothing to poll and nothing to kill. Reported as a success, "pid
          // undefined" sends the model to exec_poll with a handle that cannot
          // exist, and the command goes on running in the guest unattended.
          if (!Number.isSafeInteger(res.pid) || (res.pid as number) <= 0) {
            return refused(
              `The command was accepted but the guest reported no pid that is a usable positive safe integer, so there is no safe handle to poll or kill it with. It may still be running inside the computer — check with exec "ps aux".`,
              res,
            );
          }
          return said(
            `Started as pid ${res.pid}. Read its output with exec_poll, stop it with exec_kill.`,
            res,
          );
        }
        return said(execSummary(res), res);
      }),
  );

  server.registerTool(
    'exec_poll',
    {
      title: 'Read a background command',
      description:
        'What a backgrounded command has printed since the last time you asked, and whether it has finished. The output is a cursor, not a buffer: each poll gives you only the new bytes, so two readers on one pid split the output between them rather than each seeing all of it.',
      inputSchema: {
        ...idArg,
        pid: pidSchema,
      },
      // Deliberately not readOnlyHint. It read as one — nothing is created and
      // nothing is destroyed — but the annotation is the sentence directly
      // above it, negated: a poll advances a cursor in the guest, so the bytes
      // it returns are bytes no later poll can return. Clients treat the hint
      // as licence to call without asking and to retry a call that timed out,
      // and a retried "read-only" poll silently drops whatever the first
      // attempt had already consumed.
    },
    ({ computer_id, pid }, extra) =>
      guarded(async () => {
        const id = session.resolve(computer_id);
        const res = await session.api
          .with(extra.signal)
          .json<Record<string, unknown>>('GET', P.execHandle(id, pid));
        const more = res.more
          ? '\n\n`more` is set — there is further output waiting; poll again straight away.'
          : '';
        return said(`${execSummary(res)}${more}`, res);
      }),
  );

  server.registerTool(
    'exec_kill',
    {
      title: 'Stop a background command',
      description:
        'Kill a backgrounded command and everything it started. Answers with its final state, including whatever it printed that you had not read.',
      inputSchema: { ...idArg, pid: pidSchema },
      annotations: { destructiveHint: true },
    },
    ({ computer_id, pid }, extra) =>
      guarded(async () => {
        const id = session.resolve(computer_id);
        // `send`, because a DELETE answering 204 is the ordinary REST shape and
        // `json` now raises on an empty body. Reported as an error, the kill
        // that in fact succeeded would send the model back at a pid that no
        // longer exists.
        const res = await session.api
          .with(extra.signal)
          .send<Record<string, unknown>>('DELETE', P.execHandle(id, pid));
        return said(`Killed pid ${pid}.`, res);
      }),
  );

  server.registerTool(
    'open_url',
    {
      title: 'Open a URL on the desktop',
      description:
        "Put a web page on the screen in the guest's browser. The command returns before the window draws — on a cold browser that gap has been as long as ten seconds — so screenshot until the screen changes rather than concluding from one frame that nothing launched.",
      inputSchema: { ...idArg, url: z.string().url() },
    },
    ({ computer_id, url }, extra) =>
      guarded(async () => {
        const id = session.resolve(computer_id);
        const res = await session.api
          .with(extra.signal)
          .json<Record<string, unknown>>('POST', P.computerAction(id, 'exec'), {
            body: P.execBody({ command: P.openUrlCommand(url), timeout_s: 30, desktop: true }),
          });
        return said(
          `Asked the desktop to open ${url}. Give it a few seconds, then screenshot — the browser draws after the command returns.`,
          res,
        );
      }),
  );

  server.registerTool(
    'list_windows',
    {
      title: 'List what is on the desktop',
      description:
        'The windows the window manager knows about — id, title, class, geometry, focus. A screenshot says what the desktop looks like; this says what any of it is, which is how you tell a browser that failed to open from one that has not painted yet. Match on class, not title: the class is the application, the title is whatever page it is showing. Linux only.',
      inputSchema: {
        ...idArg,
        include_all: z
          .boolean()
          .default(false)
          .describe(
            'Include panels, the desktop wallpaper and other furniture. Off by default — a stock guest with one terminal open has five windows, four of which are not applications.',
          ),
      },
      annotations: { readOnlyHint: true },
    },
    ({ computer_id, include_all }, extra) =>
      guarded(async () => {
        const id = session.resolve(computer_id);
        const res = await session.api
          .with(extra.signal)
          .json('GET', P.computerAction(id, 'windows'), {
            query: { include: include_all ? 'all' : undefined },
          });
        return json(res);
      }),
  );

  server.registerTool(
    'window_action',
    {
      title: 'Act on a window',
      description:
        'Focus, raise, minimize, maximize, unmaximize, close, move or resize one window. The reply is the window afterwards, not an acknowledgement — the window manager places the frame and applications snap to their own grid, so a move to 300,200 routinely lands at 305,229. Believe the response, not the request. Prefer focus over raise: raising without focusing gives a window that is visibly in front and silently not receiving keystrokes.',
      inputSchema: {
        ...idArg,
        window_id: z.string().describe('From list_windows, e.g. "0x2600003".'),
        action: z.enum(P.WINDOW_ACTIONS),
        x: z.number().int().optional().describe('For move.'),
        y: z.number().int().optional().describe('For move.'),
        width: z.number().int().optional().describe('For resize.'),
        height: z.number().int().optional().describe('For resize.'),
      },
    },
    ({ computer_id, window_id, action, x, y, width, height }, extra) =>
      guarded(async () => {
        const id = session.resolve(computer_id);
        const res = await session.api.with(extra.signal).json('POST', P.window_(id, window_id), {
          body: P.windowBody({ action, x, y, width, height }),
        });
        return said(`${action} on ${window_id}. This is the window as it now is:`, res);
      }),
  );

  server.registerTool(
    'read_clipboard',
    {
      title: "Read the desktop's clipboard",
      description:
        "What is on the computer's desktop clipboard right now — the CLIPBOARD selection, which is what Ctrl-C writes and Ctrl-V pastes. Use this rather than running xclip through exec: exec runs a login shell, so anything the guest user's profile prints lands on the same output ahead of your command's, which corrupts a read you are trying to parse. This does not share that stream. It works on every Linux computer with a desktop — no reboot and no particular image — and is refused on Windows. It is a READ, not a subscription: nothing notices a copy in the guest on its own. It also does not wake a suspended computer, so a stopped or suspended one is refused rather than started; start_computer first if you need it. That refusal is a 409 and clears once it is running — but a computer built from a golden older than the clipboard is refused with a 400 that never clears, and says so. At most 128 KiB comes back, and more than that is refused rather than cut short.",
      inputSchema: { ...idArg },
      annotations: { readOnlyHint: true },
    },
    ({ computer_id }, extra) =>
      guarded(async () => {
        const id = session.resolve(computer_id);
        const res = await session.api
          .with(extra.signal)
          .json<{ text?: unknown }>('GET', P.computerAction(id, 'clipboard'));
        // Checked rather than rendered. `String(undefined)` is "undefined" — a
        // clipboard nobody copied, which a model would go on to paste.
        if (typeof res?.text !== 'string') {
          return refused(
            'The clipboard read came back with no text in it. Nothing was read; try again, and if it keeps happening the computer may not have a desktop session up yet.',
          );
        }
        return res.text === ''
          ? said('The desktop clipboard is empty.')
          : said('On the desktop clipboard:', { text: res.text });
      }),
  );

  server.registerTool(
    'write_clipboard',
    {
      title: "Put text on the desktop's clipboard",
      description:
        'Puts text on the computer\u2019s desktop clipboard, ready to paste. This leaves it on the clipboard and touches nothing on screen — follow it with press_key and keys ["ctrl","v"] to get the text into whatever has focus. Those are two separate key NAMES in the array, not one string "ctrl+v", which press_key would reject as an unknown key. Use this rather than the setsid/xclip/base64 recipe through exec: it is one call, it is confirmed, and it cannot be broken by a quote in the text. Unlike read_clipboard this DRIVES the computer, so a suspended one is resumed to serve it and that resume is charged. At most 64 KiB of text goes in — half what comes out, because the text crosses to the guest inside a single command argument. Refused on Windows. The platform confirms the write by reading the selection back before it answers, so a success here means the desktop is holding your text rather than that a command ran; a refusal saying the desktop did not take it means something else claimed the clipboard in that instant, and retrying works. Not every refusal here does: the computer not running, or its desktop not up yet, are also 409s and they need start_computer or waiting for the guest rather than another attempt — read the message before you retry. A 400 about the image never clears at all.',
      inputSchema: {
        ...idArg,
        text: z.string().describe('The text to put on the clipboard. At most 64 KiB of UTF-8.'),
      },
    },
    ({ computer_id, text }, extra) =>
      guarded(async () => {
        const id = session.resolve(computer_id);
        await session.api
          .with(extra.signal)
          .json('PUT', P.computerAction(id, 'clipboard'), { body: P.clipboardBody(text) });
        return said(
          'On the desktop clipboard, and the desktop has taken it. Press ctrl+v to paste it into whatever has focus.',
        );
      }),
  );

  server.registerTool(
    'write_file',
    {
      title: 'Put a file into the guest',
      description:
        'Write a file inside the computer. Paths must be absolute — the guest agent inherits whatever working directory it was started in, so a relative path resolves somewhere you did not name.',
      inputSchema: {
        ...idArg,
        path: absolutePath('path').describe(
          'Absolute path inside the guest, e.g. /home/user/Desktop/notes.txt.',
        ),
        content: z.string().describe('The file contents.'),
        encoding: z
          .enum(['utf8', 'base64'])
          .default('utf8')
          .describe('base64 for anything that is not text.'),
      },
    },
    ({ computer_id, path, content, encoding }, extra) =>
      guarded(async () => {
        const id = session.resolve(computer_id);
        // Node's base64 decoder is lenient: it drops characters outside the
        // alphabet and stops early on bad padding, without ever throwing. A
        // truncated or garbled payload would then write a short file and be
        // reported as a success — the file is there, it is wrong, and nothing
        // says so. Checked here so the answer is a refusal instead.
        if (encoding === 'base64' && !isBase64(content)) {
          return refused(
            `That is not valid base64, and decoding it would have written a corrupt ${path} while reporting success. Nothing was written. Re-encode the content, or send it with encoding: "utf8" if it is text.`,
          );
        }
        const bytes = new Uint8Array(
          Buffer.from(content, encoding === 'base64' ? 'base64' : 'utf8'),
        );
        const res = await session.api.with(extra.signal).json<{ path?: string; bytes?: number }>(
          'PUT',
          P.computerAction(id, 'files'),
          // The path is a query parameter, and the URL builder encodes it. Doing
          // that matters more than it looks: `+` decodes to a space and `&`
          // ends the parameter, so an unencoded path with punctuation in it
          // writes a DIFFERENT file and nothing reports that, because the
          // platform never sees what was meant.
          { query: { path }, raw: bytes },
        );
        return said(`Wrote ${res.bytes ?? bytes.length} bytes to ${res.path ?? path}.`, res);
      }),
  );

  server.registerTool(
    'read_file',
    {
      title: 'Get a file out of the guest',
      description:
        'Read a file from inside the computer. Text comes back as text and images come back as images; anything else comes back base64. A large file comes back a window at a time rather than filling the conversation: `offset` says where the window starts, and the note under a truncated read gives the exact offset to pass next. There is no size a file can be that makes it unreadable this way — a 2 GB log is pages, not a refusal — but a file you want whole is still better pushed out of the guest than carried through a conversation, and the note says how.',
      inputSchema: {
        ...idArg,
        path: absolutePath('path'),
        offset: z
          .number()
          .int()
          .min(0)
          .max(Number.MAX_SAFE_INTEGER)
          .default(0)
          .describe(
            'Byte offset to start at. 0 is the beginning of the file. Each call returns a window from here, and the truncation note names the offset of the byte after the last one it returned — pass that to read on. Never assume a window covers what you asked for: read the offset out of the note rather than adding a fixed number.',
          ),
      },
      annotations: { readOnlyHint: true },
    },
    ({ computer_id, path, offset }, extra) =>
      guarded(async () => {
        const id = session.resolve(computer_id);
        let file: Bytes;
        try {
          file = await session.api.with(extra.signal).bytes(
            'GET',
            P.computerAction(id, 'files'),
            {
              query: { path },
              // The window this tool asks the platform for, which is not the
              // same as the window it will return. It is the larger of the two
              // caps below — the most this tool could ever hand back — because
              // the content type that decides between them is not known until
              // the response arrives, and asking for the text window would clip
              // every raster image over 256 KiB into something that will not
              // decode. SVG and other non-raster `image/*` types are not
              // inlined as pictures, so they take the text cap — otherwise an
              // 8 MiB SVG would land in the conversation as text/base64.
              //
              // Asking for a window at all is what makes a large file reachable:
              // without a Range the platform serves whole files and refuses
              // anything past 64 MiB outright, so this tool's answer for a 2 GB
              // log used to be a 413 and a suggestion to go and use exec.
              headers: { Range: `bytes=${offset}-${windowEnd(offset)}` },
            },
            (contentType) =>
              isInlineImage(contentType) ? MAX_INLINE_IMAGE_BYTES : MAX_INLINE_BYTES,
          );
        } catch (err) {
          if (err instanceof RangeNotSatisfiableError) return pastEnd(path, offset, err.size);
          throw err;
        }

        const served = file.window;
        // A 206 promises a particular window, and only the requested start can
        // safely be used as this page. Trusting a contradictory Content-Range
        // can skip the gap before a later window or repeat a stale earlier one
        // forever. A 200 is different: an unmeasurable file may legitimately
        // ignore Range, and that case is diagnosed below without calling it a
        // served window.
        if (served && served.start !== offset) {
          return refused(
            `${path} was requested from offset ${offset}, but the platform served a window starting at offset ${served.start}. Refusing the mismatched 206 response because using it could skip or repeat file bytes; retry the read rather than continuing from this response.`,
          );
        }

        const start = served?.start ?? 0;
        const received = file.bytes;
        const receivedNext = start + received.length;
        const total = file.totalBytes;
        const size =
          total === undefined
            ? served
              ? 'an unknown number of'
              : `more than ${receivedNext}`
            : String(total);
        // `file.truncated` is about this response body; `more` is about the
        // file. They stopped being the same question when the Range arrived: a
        // 9 MiB image comes back as a complete 8 MiB window that was never
        // truncated, and so does a window the platform trimmed. On a 206 the
        // end of the file comes from the Content-Range and nowhere else.
        const more =
          total === undefined ? served !== undefined || file.truncated : receivedNext < total;
        // Everything, rather than a part of it. Kept apart from `more` because
        // a read that began at an offset holds only a part of the file even
        // when it read that part to the end — which is what the image branch
        // has to refuse and what the header line has to say.
        const whole = start === 0 && !more;
        // The platform did not serve a window: either it said outright that it
        // cannot (`Accept-Ranges: none`, a file whose length the guest cannot
        // measure) or a hop dropped the status on the way. Either way these
        // bytes are the head of the file and an offset means nothing here.
        const unranged = !file.window;
        // And the caller asked for one, so what came back is not what was asked
        // for. This is the half that has to be said even when nothing was
        // truncated: a short /proc file read at offset 5000 arrives whole and
        // reads as a clean answer, and it is a different stretch of bytes from
        // the one that was requested.
        const misled = unranged && offset > 0;

        if (isInlineImage(file.contentType)) {
          // A window of an image is not an image, so this stays a refusal. Two
          // ways to be holding one, and they are different mistakes: a picture
          // too big to put in a conversation, and a picture somebody asked for
          // the middle of. Only the first is about the cap, and telling a caller
          // who passed an offset that their 40 KB icon is over an 8 MiB limit
          // would be a wrong answer wearing a real number.
          if (start > 0) {
            return refused(
              `${path} is a ${file.contentType} and this read started at offset ${start}, so what came back is a slice out of the middle of it. A slice of a PNG is not a picture, and nothing was decoded as one. Read it with offset: 0 to get the image itself — the file is ${size} bytes, and anything over ${MAX_INLINE_IMAGE_BYTES} is refused there too, with what to do about it.`,
            );
          }
          // A wildcard total says only that this is a window, never that the
          // window is the whole image. Even a short body that fitted under the
          // cap is therefore not safe to decode, and its unknown size is not
          // evidence that it exceeded the cap either.
          if (served && total === undefined) {
            return refused(
              `${path} arrived as a partial ${file.contentType} response whose total size is unknown. A window of an image is not a picture, so nothing was decoded as one. Read it again from offset: 0 through an endpoint that reports the full size, or push the original out of the guest with exec "curl -T ${shellQuote(path)} <your-upload-url>".`,
            );
          }
          // The refusal now knows the file's real length, off the window's
          // Content-Range, where it could only say "more than" before — and it
          // no longer reads as though the bytes themselves were out of reach.
          if (more) {
            return refused(
              `${path} is a ${file.contentType} of ${size} bytes, over the ${MAX_INLINE_IMAGE_BYTES}-byte inline limit. It was not read into the conversation, because an image cannot be truncated and one this size would end it. The file is not out of reach — read_file serves a window of any file at any offset — but a window of a PNG is not a picture, so shrink it in the guest and read that: exec "convert ${shellQuote(path)} -resize 1280x ${shellQuote(`${path}.small.png`)}". To keep the original, push it out of the guest with exec "curl -T ${shellQuote(path)} <your-upload-url>".`,
            );
          }
          if (received.length === 0) {
            return refused(
              `${path} came back as an empty ${file.contentType} file. Nothing was returned as an image because zero bytes cannot be decoded as one.`,
            );
          }
          // A picture that arrived whole because the offset was ignored is
          // still a picture, so it goes back — but unremarked it reads as the
          // window that was asked for, and the next offset would be ignored
          // just the same. The caption is the only place that can say so.
          const caption = misled
            ? `${path} (${size} bytes) — the offset was ignored: this file cannot be read from one, so these are its first bytes and not the ${offset} you asked from.`
            : `${path} (${size} bytes)`;
          return image(received, file.contentType, caption);
        }

        // Do not advance into the middle of a UTF-8 character. If the cap cut
        // a valid text prefix after the leading bytes of its final character,
        // leave those few bytes for the next page. Binary content is preserved
        // exactly: utf8Page only trims when everything before that incomplete
        // tail is itself valid UTF-8.
        const kept = more ? utf8Page(received) : received;
        const next = start + kept.length;

        const note =
          unranged && (more || misled)
            ? `\n\n[${ignoredOffset(path, file, offset, next, total, more)}]`
            : more
              ? `\n\n[${continuation(path, start, next, total)}]`
              : '';
        const where = whole
          ? `${size} bytes`
          : kept.length === 0
            ? `empty window at offset ${start} of ${size}`
            : `bytes ${start}-${next - 1} of ${size}`;
        const decoded = decodeUtf8(kept);
        if (decoded === undefined) {
          return text(
            `${path} is not text (${where}, ${file.contentType}). Base64:\n\n` +
              Buffer.from(kept).toString('base64') +
              note,
          );
        }
        return text(`${path} (${where}):\n\n${decoded}${note}`);
      }),
  );
};

/**
 * The last byte of the window a read asks for, saturated rather than wrapped.
 *
 * `offset` is bounded only by the largest integer JavaScript counts exactly, so
 * adding the window to it can leave that range — and a last-byte-pos that has
 * gone imprecise names a byte nobody meant. Clamping keeps the header a
 * well-formed range whose end is at worst past the end of the file, which the
 * platform trims to the file rather than refusing.
 */
function windowEnd(offset: number): number {
  return Math.min(offset + MAX_WINDOW_BYTES - 1, Number.MAX_SAFE_INTEGER);
}

/**
 * What to say when the platform answers 416: the offset named no byte.
 *
 * The mistake a model paging an unmeasured file will actually make, and the one
 * refusal on this route that carries its own fix — the response's Content-Range
 * gives the file's real length, so the answer can name the offset that would
 * have worked instead of leaving another guess to be made.
 *
 * An empty file is the odd case underneath it. A Range against zero bytes is
 * unsatisfiable by the letter of RFC 9110, and the platform says so, but
 * `read_file /tmp/empty` asking for the beginning of a file that has no
 * beginning is not a mistake anybody made — it is a real read of a real file
 * that happens to have nothing in it, and it was a plain answer before this
 * tool started sending a Range. It stays one.
 */
function pastEnd(path: string, offset: number, size: number | undefined): CallToolResult {
  if (size === 0) {
    return offset === 0
      ? text(`${path} (0 bytes): the file is empty.`)
      : refused(`${path} is empty, so offset ${offset} names nothing in it.`);
  }
  if (size === undefined) {
    return refused(
      `${path} has no byte at offset ${offset}, and the platform did not say how long it is. Read from offset 0 to find out how far it goes.`,
    );
  }
  return refused(
    `offset ${offset} is past the end of ${path}, which is ${size} bytes. Its last byte is at offset ${size - 1}; read_file with offset: 0 starts again from the beginning.`,
  );
}

/**
 * How much of what came back, said the same way by both notes below.
 */
function shown(next: number, start: number, total: number | undefined): string {
  const of = total === undefined ? 'an unknown number of' : String(total);
  return `showed ${next - start} of ${of} bytes${start ? `, starting at offset ${start}` : ''}`;
}

/**
 * The note under a read that did not reach the end of the file.
 *
 * It names this tool as the way past this tool, which is the whole of what
 * changed here: the note used to say `read_file has no offset and always starts
 * at the beginning`, and sent the reader to `exec "tail -c +N | head -c M"` —
 * a shell in the guest, an agent-side 16 MiB ceiling, and an off-by-one on
 * `tail`'s one-based count, all to read the next 256 KiB of a file.
 */
function continuation(
  path: string,
  start: number,
  next: number,
  total: number | undefined,
): string {
  const pieces =
    total === undefined ? 'many' : String(Math.ceil((total - next) / MAX_INLINE_BYTES));
  return (
    `truncated: ${shown(next, start, total)}. To read on, call read_file again with ` +
    `offset: ${next} — that is where this window stopped, and a window is allowed to be ` +
    `shorter than the one asked for, so it is not always where you would have counted to. ` +
    `Covering the rest would take about ${pieces} more reads; if you want the whole file rather ` +
    `than a part of it, push it out of the guest instead of through this conversation, ` +
    `e.g. exec "curl -T ${shellQuote(path)} <your-upload-url>".`
  );
}

/**
 * The note under a read whose Range the platform did not serve.
 *
 * A file whose length the guest cannot measure — a `/proc` entry — has no byte
 * positions to name, so the platform ignores the header and sends the file from
 * the start with a `200`. Two things go wrong if that is left unsaid, and they
 * are different enough to need separate sentences: bytes the caller asked for at
 * an offset are not the bytes it got, and there is no offset that would have
 * worked, so an answer that reads like an ordinary truncation sends a paging
 * loop round to ask for the same bytes forever.
 *
 * This is the one place the exec workaround survives, and it earns its keep
 * here: `tail -c +N` is the only thing that can start part-way into a file this
 * route will only ever hand over whole.
 */
function ignoredOffset(
  path: string,
  file: Bytes,
  offset: number,
  next: number,
  total: number | undefined,
  more: boolean,
): string {
  const head = more
    ? `truncated: ${shown(next, 0, total)}`
    : `read whole: ${next} bytes, which is all of ${path}`;
  const why = file.unrangeable
    ? `${path} has no length the guest can report — a /proc entry, say — so the platform served it from the start and ignored the offset`
    : `the platform answered with the whole file rather than a window, so it ignored the offset`;
  const what =
    offset > 0
      ? `these bytes are the START of ${path}, not the ${offset} you asked from`
      : 'an offset would be ignored the same way, so this file cannot be paged';
  const onward = more
    ? `Read on with exec "tail -c +${next + 1} ${shellQuote(path)} | head -c ${MAX_INLINE_BYTES}" instead — tail counts from one, which is why that number is one past the last byte shown.`
    : `Nothing is missing from this answer. To read part of a file like this rather than all of it, use exec "tail -c +N ${shellQuote(path)} | head -c M" — tail counts from one, so N is your offset plus one.`;
  return `${head}. ${why} — ${what}. ${onward}`;
}

/**
 * Whether a string is base64 the decoder will not silently repair.
 *
 * Drawn to match what Node actually decodes correctly, not to a stricter idea
 * of the format: padding is optional, and the base64url alphabet decodes to the
 * same bytes as the standard one, so refusing either would reject content that
 * used to be written byte-perfectly — with a message claiming it was corrupt.
 * Whitespace is tolerated too; models wrap long payloads, and a newline every
 * 76 characters is what most encoders emit.
 *
 * What is left is the part that genuinely cannot be decoded: a character
 * outside both alphabets, or a length of 4n+1, which is not a whole number of
 * bytes in any padding convention.
 */
function isBase64(s: string): boolean {
  const compact = s.replace(/\s+/g, '');
  if (!compact) return true;
  if (!/^[A-Za-z0-9+/\-_]*={0,2}$/.test(compact)) return false;
  return compact.replace(/=+$/, '').length % 4 !== 1;
}

/** Quote one guest path as a single POSIX-shell argument. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** How many bytes a UTF-8 lead promises, or 1 if it is not a multi-byte lead. */
function utf8Expected(first: number): number {
  return first >= 0xc2 && first <= 0xdf
    ? 2
    : first >= 0xe0 && first <= 0xef
      ? 3
      : first >= 0xf0 && first <= 0xf4
        ? 4
        : 1;
}

/**
 * Start of a genuinely incomplete multi-byte sequence at the tail, if any.
 *
 * Walks back over continuation bytes to the lead. Accepts only a valid lead
 * whose remaining bytes are all continuations and whose length is short of
 * what that lead promised — not "any 1–3 octets that make the prefix decode".
 */
function incompleteUtf8Lead(bytes: Uint8Array): number | undefined {
  if (bytes.length === 0) return undefined;
  let lead = bytes.length - 1;
  while (lead > 0 && bytes[lead] >= 0x80 && bytes[lead] <= 0xbf) lead--;
  const expected = utf8Expected(bytes[lead]);
  const present = bytes.length - lead;
  if (expected <= 1 || present >= expected) return undefined;
  return lead;
}

/** UTF-8 if it is UTF-8, and undefined if it plainly is not. */
function decodeUtf8(bytes: Uint8Array): string | undefined {
  // A NUL is legal UTF-8 and is never in a file anybody meant to read as text.
  if (bytes.includes(0)) return undefined;
  const fatal = new TextDecoder('utf-8', { fatal: true });
  try {
    return fatal.decode(bytes);
  } catch {
    // A truncated read can cut a multi-byte character in half. One incomplete
    // sequence at the very end is a casualty of the cap rather than proof the
    // file is binary. A real U+FFFD (EF BF BD) is valid UTF-8 and decodes
    // fatally above. Stray 0xff/0xfe (or any other invalid suffix) must not
    // be stripped until the prefix happens to decode.
    const lead = incompleteUtf8Lead(bytes);
    if (lead === undefined) return undefined;
    try {
      return `${fatal.decode(bytes.subarray(0, lead))}\ufffd`;
    } catch {
      return undefined;
    }
  }
}

/** Leave an incomplete final UTF-8 character for the next byte window. */
function utf8Page(bytes: Uint8Array): Uint8Array {
  if (bytes.length === 0) return bytes;
  const lead = incompleteUtf8Lead(bytes);
  // Never return an empty page with the same continuation offset. This can
  // only happen for an unusually tiny partial response, not at the normal cap.
  if (lead === undefined || lead === 0) return bytes;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, lead));
    return bytes.subarray(0, lead);
  } catch {
    return bytes;
  }
}

/** The one line a model needs off an exec result, before the JSON. */
function execSummary(res: Record<string, unknown>): string {
  const bits: string[] = [];
  if (res.running) bits.push('still running');
  // `!= null` and not `!== undefined`: null is the natural JSON encoding of "no
  // exit code yet" for a command that was killed or timed out, and it printed
  // straight through as the line "exit null".
  else if (res.exit_code != null) bits.push(`exit ${res.exit_code}`);
  if (res.timed_out) {
    bits.push(
      'TIMED OUT — the command is still running inside the guest; nothing killed it. Re-run with background: true if you need its output',
    );
  }
  if (res.out_truncated) {
    bits.push(
      "OUTPUT TRUNCATED at the guest agent's 16 MiB cap — the exit code is not the signal here, the flag is",
    );
  }
  if (res.killed) bits.push('killed');
  return bits.length ? bits.join('; ') : 'done';
}
