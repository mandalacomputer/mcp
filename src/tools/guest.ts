import { z } from 'zod';
import { guarded, image, json, said, text } from '../format.js';
import * as P from '../paths.js';
import type { Registrar } from './types.js';

const idArg = {
  computer_id: z
    .string()
    .optional()
    .describe('Which computer. Defaults to the one selected with use_computer.'),
};

/**
 * How much of a file this server will put into a model's context.
 *
 * The platform caps a transfer at 64 MiB, which is right for artifacts and
 * catastrophic for a context window. A read that came back at that size would
 * not be a large answer, it would be the end of the conversation — so the read
 * is bounded here and says how much it kept.
 */
const MAX_INLINE_BYTES = 256 * 1024;

/**
 * The same bound for an image, which cannot be truncated.
 *
 * Larger than the text cap because base64 of a screenshot is the one big thing
 * worth carrying, and because a picture is the whole point of this server — but
 * bounded, because the alternative is not a large answer either.
 */
const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024;

export const registerGuest: Registrar = (server, session) => {
  server.registerTool(
    'exec',
    {
      title: 'Run a command in the guest',
      description:
        'Run a shell command inside the computer. Runs as root with no display by default — anything that opens a window needs desktop: true, and anything slower than a few seconds needs background: true.',
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
            'How long to wait for it to exit. A command that outlives this keeps running inside the guest — your deadline passing means you stopped waiting, not that the work was destroyed.',
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
        cwd: z.string().optional().describe('Absolute path to run in.'),
      },
    },
    ({ computer_id, command, timeout_s, desktop, background, cwd }) =>
      guarded(async () => {
        const id = session.resolve(computer_id);
        const res = await session.api.json<Record<string, unknown>>(
          'POST',
          P.computerAction(id, 'exec'),
          { body: P.execBody({ command, timeout_s, desktop, background, cwd }) },
        );
        if (background) {
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
        pid: z.number().int().describe('The pid exec returned.'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ computer_id, pid }) =>
      guarded(async () => {
        const id = session.resolve(computer_id);
        const res = await session.api.json<Record<string, unknown>>('GET', P.execHandle(id, pid));
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
      inputSchema: { ...idArg, pid: z.number().int() },
      annotations: { destructiveHint: true },
    },
    ({ computer_id, pid }) =>
      guarded(async () => {
        const id = session.resolve(computer_id);
        const res = await session.api.json<Record<string, unknown>>(
          'DELETE',
          P.execHandle(id, pid),
        );
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
    ({ computer_id, url }) =>
      guarded(async () => {
        const id = session.resolve(computer_id);
        const res = await session.api.json<Record<string, unknown>>(
          'POST',
          P.computerAction(id, 'exec'),
          { body: P.execBody({ command: P.openUrlCommand(url), timeout_s: 30, desktop: true }) },
        );
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
    ({ computer_id, include_all }) =>
      guarded(async () => {
        const id = session.resolve(computer_id);
        const res = await session.api.json('GET', P.computerAction(id, 'windows'), {
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
    ({ computer_id, window_id, action, x, y, width, height }) =>
      guarded(async () => {
        const id = session.resolve(computer_id);
        const res = await session.api.json('POST', P.window_(id, window_id), {
          body: P.windowBody({ action, x, y, width, height }),
        });
        return said(`${action} on ${window_id}. This is the window as it now is:`, res);
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
        path: z
          .string()
          .describe('Absolute path inside the guest, e.g. /home/user/Desktop/notes.txt.'),
        content: z.string().describe('The file contents.'),
        encoding: z
          .enum(['utf8', 'base64'])
          .default('utf8')
          .describe('base64 for anything that is not text.'),
      },
    },
    ({ computer_id, path, content, encoding }) =>
      guarded(async () => {
        const id = session.resolve(computer_id);
        // Node's base64 decoder is lenient: it drops characters outside the
        // alphabet and stops early on bad padding, without ever throwing. A
        // truncated or garbled payload would then write a short file and be
        // reported as a success — the file is there, it is wrong, and nothing
        // says so. Checked here so the answer is a refusal instead.
        if (encoding === 'base64' && !isBase64(content)) {
          return said(
            `That is not valid base64, and decoding it would have written a corrupt ${path} while reporting success. Nothing was written. Re-encode the content, or send it with encoding: "utf8" if it is text.`,
          );
        }
        const bytes = new Uint8Array(
          Buffer.from(content, encoding === 'base64' ? 'base64' : 'utf8'),
        );
        const res = await session.api.json<{ path?: string; bytes?: number }>(
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
        'Read a file from inside the computer. Text comes back as text and images come back as images; anything else comes back base64. Large files are truncated here rather than filling the conversation.',
      inputSchema: {
        ...idArg,
        path: z.string().describe('Absolute path inside the guest.'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ computer_id, path }) =>
      guarded(async () => {
        const id = session.resolve(computer_id);
        const file = await session.api.bytes('GET', P.computerAction(id, 'files'), {
          query: { path },
        });
        if (file.contentType.startsWith('image/')) {
          // The cap applies here too. Clipping is not an option — half a PNG is
          // not a picture — so an oversized image is refused with its size,
          // which is something a model can act on. Without this the image path
          // walked straight past the bound the rest of this tool observes, and
          // 64 MiB of screenshot became ~85 MB of base64 in the context.
          if (file.bytes.length > MAX_INLINE_IMAGE_BYTES) {
            return text(
              `${path} is a ${file.contentType} of ${file.bytes.length} bytes, over the ${MAX_INLINE_IMAGE_BYTES}-byte inline limit. It was not read into the conversation, because an image cannot be truncated and one this size would end it. Shrink it in the guest first — e.g. exec "convert ${path} -resize 1280x ${path}.small.png" — and read that.`,
            );
          }
          return image(file.bytes, file.contentType, `${path} (${file.bytes.length} bytes)`);
        }
        const kept = file.bytes.subarray(0, MAX_INLINE_BYTES);
        const truncated = file.bytes.length > MAX_INLINE_BYTES;
        const note = truncated
          ? `\n\n[truncated: showed ${kept.length} of ${file.bytes.length} bytes]`
          : '';
        const decoded = decodeUtf8(kept);
        if (decoded === undefined) {
          return text(
            `${path} is not text (${file.bytes.length} bytes, ${file.contentType}). Base64:\n\n` +
              Buffer.from(kept).toString('base64') +
              note,
          );
        }
        return text(`${path} (${file.bytes.length} bytes):\n\n${decoded}${note}`);
      }),
  );
};

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

/** UTF-8 if it is UTF-8, and undefined if it plainly is not. */
function decodeUtf8(bytes: Uint8Array): string | undefined {
  // Non-fatal on purpose. A truncated read can cut a multi-byte character in
  // half, and one replacement character at the very end is a casualty of the
  // cap rather than proof the file is binary.
  const s = new TextDecoder('utf-8').decode(bytes);
  // A NUL is legal UTF-8 and is never in a file anybody meant to read as text,
  // so it is the tell that this is a binary. Replacement characters anywhere
  // but the tail say the same thing.
  if (s.includes('\u0000')) return undefined;
  const bad = s.split('\ufffd').length - 1;
  if (bad > 1 || (bad === 1 && !s.slice(-4).includes('\ufffd'))) return undefined;
  return s;
}

/** The one line a model needs off an exec result, before the JSON. */
function execSummary(res: Record<string, unknown>): string {
  const bits: string[] = [];
  if (res.running) bits.push('still running');
  else if (res.exit_code !== undefined) bits.push(`exit ${res.exit_code}`);
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
