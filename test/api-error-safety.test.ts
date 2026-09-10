import { afterEach, describe, expect, it } from 'vitest';
import { Api, MODEL_KEY_HEADER, platformFetch } from '../src/api.js';
import { ConnectivityError, ConnectivityInterruptedError, MandalaError } from '../src/errors.js';

const BASE = 'https://api.example.invalid/api/v1';
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('request failure diagnostics', () => {
  it('does not repeat a rejected base URL in configuration errors', () => {
    for (const configured of [
      'not-a-url?token=config-value-canary',
      'file://config-user-canary:config-password-canary@localhost/tmp/platform',
    ]) {
      expect(() => new Api('com_synthetic', configured)).toThrow(MandalaError);
      try {
        new Api('com_synthetic', configured);
      } catch (err) {
        expect((err as Error).message).not.toContain('config-value-canary');
        expect((err as Error).message).not.toContain('config-user-canary');
        expect((err as Error).message).not.toContain('config-password-canary');
      }
    }
  });

  const validationCases = [
    {
      name: 'API authorization header',
      markers: ['api-value-canary'],
      rawUrl: `${BASE}/computers`,
      rawInit: { headers: { Authorization: 'Bearer api-value-canary\ncontinuation' } },
      request: () => new Api('api-value-canary\ncontinuation', BASE).json('GET', 'computers'),
    },
    {
      name: 'model authorization header',
      markers: ['model-value-canary'],
      rawUrl: `${BASE}/computers/vm-1/agent`,
      rawInit: { headers: { [MODEL_KEY_HEADER]: 'model-value-canary\ncontinuation' } },
      request: () =>
        new Api('com_synthetic', BASE).json('POST', 'computers/vm-1/agent', {
          headers: { [MODEL_KEY_HEADER]: 'model-value-canary\ncontinuation' },
          body: { prompt: 'hello' },
        }),
    },
    {
      name: 'URL user information',
      markers: ['url-user-canary', 'url-password-canary', 'url-query-canary'],
      rawUrl:
        'https://url-user-canary:url-password-canary@example.invalid/api/v1/computers?access_token=url-query-canary',
      rawInit: {},
      request: () =>
        new Api(
          'com_synthetic',
          'https://url-user-canary:url-password-canary@example.invalid/api/v1?access_token=url-query-canary',
        ).json('GET', 'computers'),
    },
  ] as const;

  for (const testCase of validationCases) {
    it(`sanitizes an undici rejection of the ${testCase.name}`, async () => {
      // Prove the fixture reaches undici's synchronous request validation and
      // that its raw exception contains the input a tool result must not repeat.
      const raw = await platformFetch()(testCase.rawUrl, testCase.rawInit).catch(
        (err: unknown) => err,
      );
      expect(raw).toBeInstanceOf(TypeError);
      for (const marker of testCase.markers) {
        expect((raw as Error).message).toContain(marker);
      }

      const err = await testCase.request().catch((cause: unknown) => cause);
      expect(err).toBeInstanceOf(MandalaError);
      expect(err).not.toBeInstanceOf(ConnectivityError);
      expect(err).not.toBeInstanceOf(ConnectivityInterruptedError);
      expect((err as Error).message).toMatch(/rejected locally before it could be sent/i);
      for (const { markers } of validationCases) {
        for (const marker of markers) {
          expect((err as Error).message).not.toContain(marker);
        }
      }
    });
  }

  it('keeps cancellation ahead of local validation', async () => {
    const controller = new AbortController();
    controller.abort();

    const err = await new Api('api-cancel-canary\ncontinuation', BASE, controller.signal)
      .json('GET', 'computers')
      .catch((cause: unknown) => cause);

    expect(err).toMatchObject({ name: 'CancelledError' });
    expect((err as Error).message).not.toContain('api-cancel-canary');
  });

  it('does not expose text from an unrecognized fetch exception', async () => {
    const marker = 'exception-text-canary';
    globalThis.fetch = (async () => {
      throw new Error(`transport failed around ${marker}`);
    }) as typeof fetch;

    const err = await new Api('com_synthetic', BASE)
      .json('POST', 'computers', { body: { name: 'desk' } })
      .catch((cause: unknown) => cause);

    // An unknown exception cannot prove that a mutating request stayed local,
    // so it keeps the possibly-dispatched classification without its raw text.
    expect(err).toBeInstanceOf(ConnectivityInterruptedError);
    expect((err as Error).message).toMatch(/failed after the request was sent/i);
    expect((err as Error).message).not.toContain(marker);
  });

  it('does not expose text from a response-body transport exception', async () => {
    const marker = 'response-error-canary';
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            const err = new Error(`response failed around ${marker}`);
            err.name = 'AbortError';
            controller.error(err);
          },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      )) as typeof fetch;

    const err = await new Api('com_synthetic', BASE)
      .json('GET', 'computers')
      .catch((cause: unknown) => cause);

    expect(err).toBeInstanceOf(ConnectivityInterruptedError);
    expect((err as Error).message).toMatch(/request was received/i);
    expect((err as Error).message).not.toContain(marker);
  });
});
