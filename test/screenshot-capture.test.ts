import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { errorForStatus, isTransient, reasonKind } from '../src/errors.js';
import { connect, installFakePlatform } from './harness.js';

const CAPTURE = '0123456789abcdef';
const NEW_CAPTURE = 'fedcba9876543210';
const textOf = (res: CallToolResult) =>
  res.content.map((c) => ('text' in c ? c.text : '')).join('\n');

describe('screenshots pinned to the capture that was measured (OPL-5856)', () => {
  let platform: ReturnType<typeof installFakePlatform>;
  beforeEach(() => {
    platform = installFakePlatform();
  });
  afterEach(() => platform.restore());

  // Keep real MCP calls and request recording; vary only the screenshot response.
  const answer = (respond: (url: URL, response: Response) => Response | Promise<Response>) => {
    const base = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const response = await base(input as never, init);
      const url = new URL(String(input));
      return url.pathname.endsWith('/screenshot') ? respond(url, response) : response;
    }) as typeof fetch;
  };
  const withHeaders = (response: Response, headers: Record<string, string>) =>
    new Response(response.body, {
      headers: { 'Content-Type': 'image/png', ...headers },
    });
  const shots = () => platform.calls.filter((c) => c.path.endsWith('/screenshot'));

  it('does not tell direct API callers to retry an evicted capture', () => {
    const error = errorForStatus(409, 'capture is no longer held', { reason: 'stale_capture' });
    expect(reasonKind('stale_capture')).toBe('permanent');
    expect(isTransient(error)).toBe(false);
  });

  it('surfaces the original dimensions and reuses the named capture after a newer frame exists', async () => {
    let current = CAPTURE;
    answer((url, response) => {
      const capture = url.searchParams.get('capture') ?? current;
      return withHeaders(response, {
        'X-GC-Capture': capture,
        'X-GC-Capture-Size': capture === CAPTURE ? '1600x900' : '1920x1080',
      });
    });
    const { call, close } = await connect();
    try {
      await call('get_computer'); // The record says 1280x800x24, not either capture's size.
      const full = await call('screenshot');
      expect(textOf(full)).toContain(`Capture: ${CAPTURE}`);
      expect(textOf(full)).toContain('1600x900 pixels before cropping or scaling');
      expect(textOf(full)).not.toContain('1280x800');
      current = NEW_CAPTURE;
      expect(textOf(await call('screenshot'))).toContain('1920x1080');
      const crop = await call('screenshot', {
        capture: CAPTURE,
        region: { x: 100, y: 50, width: 640, height: 400 },
        scale: 0.5,
        format: 'jpeg',
        quality: 60,
      });
      expect(crop.isError).toBeFalsy();
      expect(crop.content.some((c) => c.type === 'image')).toBe(true);
      expect(textOf(crop)).toContain(`Capture: ${CAPTURE}`);
      expect(textOf(crop)).toContain('1600x900 pixels before cropping or scaling');
      expect(textOf(crop)).not.toContain('1920x1080');
      expect(textOf(crop)).toContain('divide its position by 0.5, then add 100 to x and 50 to y');
      const queries = shots().map((s) => Object.fromEntries(s.query));
      expect(queries).toEqual([
        { fresh: '1' },
        { fresh: '1' },
        { capture: CAPTURE, region: '100,50,640,400', scale: '0.5', format: 'jpeg', quality: '60' },
      ]);
    } finally {
      await close();
    }
  });

  it('uses response dimensions for an explicitly selected different computer, including width-only images', async () => {
    answer((_, response) =>
      withHeaders(response, { 'X-GC-Capture': CAPTURE, 'X-GC-Capture-Size': '1600x900' }),
    );
    const { call, close } = await connect();
    try {
      await call('get_computer');
      const result = await call('screenshot', { computer_id: 'vm-9', width: 800 });
      expect(textOf(result)).toContain('1600x900 pixels before cropping or scaling');
      expect(textOf(result)).not.toContain('1280x800');
      expect(shots()[0].path).toBe('/computers/vm-9/screenshot');
      expect(shots()[0].query.get('w')).toBe('800');
    } finally {
      await close();
    }
  });

  it('accepts explicit fresh: false with capture and rejects incompatible or malformed pins before dispatch', async () => {
    const { call, close } = await connect();
    try {
      expect((await call('screenshot', { capture: CAPTURE, fresh: false })).isError).toBeFalsy();
      expect(shots()[0].query.get('capture')).toBe(CAPTURE);
      expect(shots()[0].query.has('fresh')).toBe(false);
      const before = platform.calls.length;
      const conflict = await call('screenshot', { capture: CAPTURE, fresh: true });
      expect(conflict.isError).toBe(true);
      expect(textOf(conflict)).toContain('Nothing was sent');
      for (const capture of ['', 'ABCDEF0123456789', '0123456789abcde', `${CAPTURE}0`]) {
        expect((await call('screenshot', { capture })).isError).toBe(true);
      }
      expect(platform.calls).toHaveLength(before);
    } finally {
      await close();
    }
  });

  it.each(['stale_capture', 'unavailable'])(
    'never substitutes another frame after a pinned %s refusal',
    async (reason) => {
      answer(() => Response.json({ error: 'cannot serve this capture', reason }, { status: 409 }));
      const { call, close } = await connect();
      try {
        const result = await call('screenshot', {
          capture: CAPTURE,
          region: { x: 1, y: 2, width: 30, height: 40 },
        });
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain(reason);
        expect(textOf(result)).not.toContain('fresh: false');
        expect(result.content.some((c) => c.type === 'image')).toBe(false);
        expect(shots()).toHaveLength(1);
        if (reason === 'stale_capture') {
          expect(textOf(result)).toContain('without capture or region, then remeasure');
        }
      } finally {
        await close();
      }
    },
  );

  it.each<Record<string, string>>([
    {},
    { 'X-GC-Capture': NEW_CAPTURE },
    { 'X-GC-Capture': CAPTURE },
    { 'X-GC-Capture': CAPTURE, 'X-GC-Capture-Size': '0x900' },
    { 'X-GC-Capture': CAPTURE, 'X-GC-Capture-Size': '1600x900', 'X-GC-Frame': 'suspended' },
  ])('refuses an image that does not confirm the requested live capture (%j)', async (headers) => {
    answer((_, response) => withHeaders(response, headers));
    const { call, close } = await connect();
    try {
      const result = await call('screenshot', { capture: CAPTURE });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('did not confirm');
      expect(result.content.some((c) => c.type === 'image')).toBe(false);
      expect(shots()).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it.each<Record<string, string>>([
    {},
    { 'X-GC-Capture': 'not a capture', 'X-GC-Capture-Size': '0x900' },
    { 'X-GC-Capture-Size': '9007199254740992x900' },
    { 'X-GC-Capture-Size': '1600x900 pixels' },
  ])('does not invent capture metadata from missing or malformed headers (%j)', async (headers) => {
    answer((_, response) => withHeaders(response, headers));
    const { call, close } = await connect();
    try {
      const result = await call('screenshot');
      expect(result.isError).toBeFalsy();
      expect(textOf(result)).not.toContain('Capture:');
      expect(textOf(result)).not.toContain('Capture size');
    } finally {
      await close();
    }
  });

  it.each(['', '0x900'])(
    'does not pair a reusable capture with the computer record when its size is %j',
    async (size) => {
      answer((_, response) =>
        withHeaders(response, {
          'X-GC-Capture': CAPTURE,
          ...(size ? { 'X-GC-Capture-Size': size } : {}),
        }),
      );
      const { call, close } = await connect();
      try {
        await call('get_computer');
        const result = await call('screenshot');
        expect(result.isError).toBeFalsy();
        expect(textOf(result)).not.toContain(CAPTURE);
        expect(textOf(result)).not.toContain('1280x800');
        expect(textOf(result)).toContain('Original capture size is unavailable');
      } finally {
        await close();
      }
    },
  );

  it('never advertises suspended frames as reusable live captures', async () => {
    answer((_, response) =>
      withHeaders(response, {
        'X-GC-Frame': 'suspended',
        'X-GC-Capture': CAPTURE,
        'X-GC-Capture-Size': '1600x900',
      }),
    );
    const { call, close } = await connect();
    try {
      const result = await call('screenshot', { fresh: false });
      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain('SAVED FRAME');
      expect(textOf(result)).not.toContain(CAPTURE);
      expect(textOf(result)).not.toContain('1600x900');
    } finally {
      await close();
    }
  });
});
