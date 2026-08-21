import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_INLINE_IMAGE_BYTES } from '../src/format.js';
import { connect, download } from './harness.js';

/**
 * Paging a guest file, which is the whole of what a `Range` bought.
 *
 * The platform shipped `Range` on `GET computers/:id/files` in OPL-3727 and
 * named this server as the caller it was for. Until this, the tool's own
 * description said it "cannot page — it always starts at the beginning", and a
 * file over the platform's 64 MiB whole-file ceiling had no answer at all: a
 * 413, and a truncation note whose only route onward went through a shell in
 * the guest.
 *
 * The cases below are the ones the header actually has to survive. Three of
 * them are not the happy path and every one of them is a way a paging loop goes
 * wrong silently: a window trimmed shorter than the one asked for, a file whose
 * length the guest cannot measure and whose Range is therefore ignored, and an
 * offset past the end.
 */

const MAX_INLINE_BYTES = 256 * 1024;

/** The last request's headers, so a test can assert what went out. */
let sent: Headers;

function serve(handler: (range: string | null) => Response) {
  globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
    sent = new Headers(init?.headers ?? {});
    return Promise.resolve(handler(sent.get('range')));
  }) as typeof fetch;
}

describe('read_file pages through a large file', () => {
  const real = globalThis.fetch;
  beforeEach(() => {
    sent = new Headers();
  });
  afterEach(() => {
    globalThis.fetch = real;
  });

  it('asks for a window rather than the whole file', async () => {
    serve((range) => download('hello', range ?? undefined));
    const { call, close } = await connect();
    await call('read_file', { path: '/home/user/a.txt' });
    // The image cap, not the text one: the content type is not known until the
    // response arrives, so a window sized for text would clip every image over
    // 256 KiB into bytes that do not decode.
    expect(sent.get('range')).toBe(`bytes=0-${MAX_INLINE_IMAGE_BYTES - 1}`);
    await close();
  });

  it('sends the offset it was given and says where the window landed', async () => {
    const body = 'abcdefghij';
    serve((range) => download(body, range ?? undefined));
    const { call, close } = await connect();
    const res = await call('read_file', { path: '/home/user/a.txt', offset: 4 });
    expect(sent.get('range')).toBe(`bytes=4-${4 + MAX_INLINE_IMAGE_BYTES - 1}`);
    const out = res.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    expect(out).toContain('bytes 4-9 of 10');
    expect(out).toContain('efghij');
    // The window reached the end of the file, so there is nothing to read on to.
    expect(out).not.toContain('truncated');
    await close();
  });

  it('resumes from what came back, not from what was asked for', async () => {
    // The failure this is here to stop: a window is trimmed to what one request
    // moves, so the offset of the next read is the end of the window that
    // arrived and never the end of the one that was requested. A reader adding
    // a fixed 256 KiB to its own offset skips whatever the trim took.
    const size = 4 * MAX_INLINE_BYTES;
    serve((range) => download('x'.repeat(size), range ?? undefined));
    const { call, close } = await connect();
    const res = await call('read_file', { path: '/var/log/big.log', offset: 1000 });
    const out = res.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    expect(out).toContain(`bytes 1000-${1000 + MAX_INLINE_BYTES - 1} of ${size}`);
    expect(out).toContain(`read_file again with offset: ${1000 + MAX_INLINE_BYTES}`);
    expect(out).toContain('starting at offset 1000');
    await close();
  });

  it('says how many more reads the rest of the file would take', async () => {
    const size = 10 * MAX_INLINE_BYTES;
    serve((range) => download('x'.repeat(size), range ?? undefined));
    const { call, close } = await connect();
    const res = await call('read_file', { path: '/var/log/big.log' });
    const out = res.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    // Nine left after this one, and the count is what makes "push it out of the
    // guest instead" a judgement the reader can make rather than advice.
    expect(out).toContain('about 9 more reads');
    expect(out).toContain('curl -T');
    await close();
  });

  it('reaches a file far past the platform’s whole-file ceiling', async () => {
    // The case with no answer before this: a whole-file read of anything over
    // 64 MiB is a 413, so a 2 GB build log could not be read at all. Only the
    // headers are large here; the body is the window, as it is on the wire.
    const size = 2 * 1024 * 1024 * 1024;
    serve((range) => {
      const start = Number(/^bytes=(\d+)-/.exec(range ?? '')?.[1] ?? 0);
      const window = Buffer.alloc(MAX_INLINE_IMAGE_BYTES, 121);
      return new Response(window, {
        status: 206,
        headers: {
          'Content-Type': 'text/plain',
          'Accept-Ranges': 'bytes',
          'Content-Length': String(window.length),
          'Content-Range': `bytes ${start}-${start + window.length - 1}/${size}`,
        },
      });
    });
    const { call, close } = await connect();
    const res = await call('read_file', { path: '/var/log/huge.log' });
    expect(res.isError).toBeFalsy();
    const out = res.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    expect(out).toContain(`of ${size}`);
    expect(out).toContain(`read_file again with offset: ${MAX_INLINE_BYTES}`);
    await close();
  });
});

describe('read_file when the range cannot be served', () => {
  const real = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = real;
  });

  it('does not report an ignored range as a window', async () => {
    // A /proc entry has no length the guest can report, so the platform answers
    // `Accept-Ranges: none` and sends the file from the start whatever the
    // Range said. Reporting those bytes as the window somebody asked for is how
    // a paging loop reads the same bytes forever.
    const body = 'y'.repeat(MAX_INLINE_BYTES + 1000);
    globalThis.fetch = (async () =>
      new Response(body, {
        headers: { 'Content-Type': 'text/plain', 'Accept-Ranges': 'none' },
      })) as typeof fetch;
    const { call, close } = await connect();
    const res = await call('read_file', { path: '/proc/kmsg', offset: 5000 });
    const out = res.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    expect(out).toContain('ignored the offset');
    expect(out).toContain('not the 5000 you asked from');
    expect(out).toContain('truncated:');
    // So the note must NOT send the reader back into read_file with an offset.
    expect(out).not.toContain('read_file again with offset');
    // The one place exec is still the right answer.
    expect(out).toContain(`tail -c +${MAX_INLINE_BYTES + 1}`);
    await close();
  });

  it('refuses a 206 that did not say which bytes it holds', async () => {
    // The half of the mislabel the status check did not cover. A 206 with no
    // readable Content-Range — a hop dropped it — has the same shape as a
    // whole-file 200: nothing was truncated, there is no window, and every
    // reader downstream calls it a complete file read from offset 0. A caller
    // paging stops early; a caller stitching writes the middle of the file at
    // the beginning of its copy. Nothing after this point can tell.
    globalThis.fetch = (async () =>
      new Response('efghij', {
        status: 206,
        headers: { 'Content-Type': 'text/plain', 'Accept-Ranges': 'bytes' },
      })) as typeof fetch;
    const { call, close } = await connect();
    const res = await call('read_file', { path: '/home/user/a.txt', offset: 4 });
    expect(res.isError).toBe(true);
    const out = res.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    expect(out).toContain('206 without a readable Content-Range');
    // And it must not have been passed off as the file.
    expect(out).not.toContain('efghij');
    await close();
  });

  it('warns about an ignored offset even when nothing was truncated', async () => {
    // The infinite-loop shape is covered above, and it needed the file to be
    // long enough to truncate. This is the quiet one: /proc/cpuinfo at offset
    // 5000 fits in the cap, so it comes back as a clean whole-file read with no
    // sign that the offset went nowhere — a different stretch of bytes from the
    // ones asked for, reported as a success.
    globalThis.fetch = (async () =>
      new Response('processor : 0', {
        headers: { 'Content-Type': 'text/plain', 'Accept-Ranges': 'none' },
      })) as typeof fetch;
    const { call, close } = await connect();
    const res = await call('read_file', { path: '/proc/cpuinfo', offset: 5000 });
    const out = res.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    expect(out).toContain('processor : 0');
    expect(out).toContain('not the 5000 you asked from');
    // Nothing was lost, and saying so is what keeps this from reading as a
    // failure the caller has to do something about.
    expect(out).toContain('Nothing is missing from this answer');
    await close();
  });

  it('says an image arrived whole because the offset was ignored', async () => {
    // The same gap on the image path: a small unrangeable picture at a non-zero
    // offset came back as a picture with nothing about the offset on it.
    globalThis.fetch = (async () =>
      new Response(
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
          'base64',
        ),
        { headers: { 'Content-Type': 'image/png', 'Accept-Ranges': 'none' } },
      )) as typeof fetch;
    const { call, close } = await connect();
    const res = await call('read_file', { path: '/proc/self/fd/3.png', offset: 40 });
    expect(res.isError).toBeFalsy();
    expect(res.content.some((c) => c.type === 'image')).toBe(true);
    const out = res.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    expect(out).toContain('the offset was ignored');
    expect(out).toContain('not the 40 you asked from');
    await close();
  });

  it('names the file’s real length when the offset is past the end', async () => {
    globalThis.fetch = (async () => download('abcdefghij', 'bytes=99-')) as typeof fetch;
    const { call, close } = await connect();
    const res = await call('read_file', { path: '/home/user/a.txt', offset: 99 });
    expect(res.isError).toBe(true);
    const out = res.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    // The number the caller could not have known, which is the whole reason a
    // 416 carries a Content-Range.
    expect(out).toContain('which is 10 bytes');
    expect(out).toContain('last byte is at offset 9');
    await close();
  });

  it('reads an empty file as an empty file, not as a bad range', async () => {
    // A Range against zero bytes is unsatisfiable by the letter of RFC 9110 and
    // the platform says so — but `read_file /tmp/empty` is a real read of a real
    // file, and it was a plain answer before this tool started sending a Range.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'that range is outside the file, which is empty' }), {
        status: 416,
        headers: { 'Content-Type': 'application/json', 'Content-Range': 'bytes */0' },
      })) as typeof fetch;
    const { call, close } = await connect();
    const res = await call('read_file', { path: '/tmp/empty' });
    expect(res.isError).toBeFalsy();
    expect(res.content.map((c) => (c.type === 'text' ? c.text : '')).join('')).toContain(
      '(0 bytes)',
    );
    await close();
  });
});

describe('read_file and images', () => {
  const real = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = real;
  });

  it('refuses an oversized image by the file’s size, not by the window’s', async () => {
    // The trap the Range introduced. An image past the inline cap used to be
    // caught by the response being clipped on arrival; now the WINDOW arrives
    // complete, so `truncated` is false and nothing about the response says the
    // file goes on. Half a PNG that decodes to nothing would have gone out as a
    // picture. The window's total is what settles it.
    const size = MAX_INLINE_IMAGE_BYTES + 1024;
    globalThis.fetch = (async () =>
      new Response(new Uint8Array(MAX_INLINE_IMAGE_BYTES), {
        status: 206,
        headers: {
          'Content-Type': 'image/png',
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes 0-${MAX_INLINE_IMAGE_BYTES - 1}/${size}`,
        },
      })) as typeof fetch;
    const { call, close } = await connect();
    const res = await call('read_file', { path: '/tmp/big.png' });
    expect(res.isError).toBe(true);
    expect(res.content.some((c) => c.type === 'image')).toBe(false);
    const out = res.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    // The exact size, which the old refusal could only give as "more than".
    expect(out).toContain(`of ${size} bytes`);
    // And it no longer reads as though the bytes were out of reach.
    expect(out).toContain('read_file serves a window of any file');
    await close();
  });

  it('does not decode a slice of an image, and says which mistake that was', async () => {
    // A small image read at an offset is not the same failure as a large one
    // read whole, and the cap has nothing to do with it. Telling a caller their
    // 40 KB icon is over an 8 MiB limit would be a wrong answer with a real
    // number in it.
    globalThis.fetch = (async () =>
      new Response(new Uint8Array(60), {
        status: 206,
        headers: {
          'Content-Type': 'image/png',
          'Accept-Ranges': 'bytes',
          'Content-Range': 'bytes 40-99/100',
        },
      })) as typeof fetch;
    const { call, close } = await connect();
    const res = await call('read_file', { path: '/tmp/icon.png', offset: 40 });
    expect(res.isError).toBe(true);
    expect(res.content.some((c) => c.type === 'image')).toBe(false);
    const out = res.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    expect(out).toContain('started at offset 40');
    expect(out).toContain('offset: 0');
    expect(out).not.toContain('over the');
    await close();
  });

  it('still returns an image that fits, whole', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    globalThis.fetch = (async () =>
      new Response(png, {
        status: 206,
        headers: {
          'Content-Type': 'image/png',
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes 0-${png.length - 1}/${png.length}`,
        },
      })) as typeof fetch;
    const { call, close } = await connect();
    const res = await call('read_file', { path: '/tmp/small.png' });
    expect(res.isError).toBeFalsy();
    expect(res.content.some((c) => c.type === 'image')).toBe(true);
    await close();
  });
});
