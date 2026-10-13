import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  APIError,
  codeAdvice,
  errorForStatus,
  isTransient,
  isTransientForPoll,
  reasonAdvice,
} from '../src/errors.js';
import { errorMetadata, failed } from '../src/format.js';
import { connect, installFakePlatform, SSH_PUBLIC_KEY } from './harness.js';

// OPL-5975. A 409 is transient only where the platform says it is passing: a
// `reason` of `contention` or `starting`, or a code it documents as passing.
// An absent reason is no classification, and the platform's reference says a
// client treating 409 as uniformly transient "loops forever on half of them".
// The same table holds in the TypeScript and Python SDKs.

const textOf = (res: CallToolResult) =>
  res.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

const err = (status: number, body: Record<string, unknown>) =>
  errorForStatus(status, String(body.error ?? `HTTP ${status}`), body);

describe('which refusals are transient', () => {
  it.each([
    // [label, status, body, transient]
    ['reason contention', 409, { error: 'x', reason: 'contention' }, true],
    ['reason starting', 409, { error: 'x', reason: 'starting' }, true],
    ['idempotency_in_progress', 409, { error: 'x', code: 'idempotency_in_progress' }, true],
    [
      'idempotency_in_progress with contention',
      409,
      { error: 'x', code: 'idempotency_in_progress', reason: 'contention' },
      true,
    ],
    ['WORKSPACE_MOVING, no word', 409, { error: 'x', code: 'WORKSPACE_MOVING' }, true],
    [
      'WORKSPACE_MOVING settling',
      409,
      { error: 'x', code: 'WORKSPACE_MOVING', reason: 'contention' },
      true,
    ],
    [
      'WORKSPACE_MOVING stuck',
      409,
      { error: 'x', code: 'WORKSPACE_MOVING', reason: 'unsupported' },
      false,
    ],
    [
      'idempotency_outcome_unknown',
      409,
      { error: 'x', code: 'idempotency_outcome_unknown' },
      false,
    ],
    [
      'LABEL_TAKEN',
      409,
      { error: 'The label "a" is taken; choose another.', code: 'LABEL_TAKEN' },
      false,
    ],
    ['PUBLIC_URL_LIMIT', 409, { error: 'x', code: 'PUBLIC_URL_LIMIT' }, false],
    ['PUBLIC_URLS_BLOCKED', 403, { error: 'x', code: 'PUBLIC_URLS_BLOCKED' }, false],
    ['PUBLIC_URLS_DISABLED', 404, { error: 'x', code: 'PUBLIC_URLS_DISABLED' }, false],
    [
      'the webhook subscription cap',
      409,
      {
        error:
          'This account already has 5 of the 5 webhook subscriptions its plan allows; delete one first.',
      },
      false,
    ],
    [
      'a test of a disabled webhook',
      409,
      {
        error:
          'This webhook is disabled. Enable it with PATCH {"enabled": true} before sending a test.',
      },
      false,
    ],
    [
      'an SSH key already registered',
      409,
      { error: 'That key is already registered. A key can belong to one person only.' },
      false,
    ],
    [
      'the SSH key limit',
      409,
      { error: 'You already have 50 SSH keys, which is the limit. Remove one first.' },
      false,
    ],
    ['a code nobody documents as passing', 409, { error: 'x', code: 'SOMETHING_ELSE' }, false],
    ['a bare 409', 409, {}, false],
    ['a daily rate limit', 429, { error: 'x', code: 'RATE_LIMITED' }, true],
  ] as const)('%s', (_label, status, body, transient) => {
    const e = err(status, body);
    expect(isTransient(e)).toBe(transient);
    // The wait tools replay reads under a deadline, and still ride out every
    // 409 and 429; this is only the published answer.
    if (status === 409 || status === 429) expect(isTransientForPoll(e)).toBe(true);
  });

  // The same edges as the TypeScript SDK: a nested word grants nothing, and a
  // word that clears is about a 400 or a 409, not another status.
  it('lets neither a nested word nor a word on another status grant a retry', () => {
    const nested = errorForStatus(409, 'x', {
      error: { message: 'x', reason: 'contention' },
      code: 'WORKSPACE_MOVING',
    });
    expect(nested.reason).toBe('contention');
    expect(isTransient(nested)).toBe(false);
    expect(isTransient(err(500, { error: 'x', reason: 'contention' }))).toBe(false);
    expect(isTransient(err(400, { error: 'x', reason: 'contention' }))).toBe(true);
    // An unknown word is no word: the code decides.
    expect(isTransient(err(409, { error: 'x', reason: 'new', code: 'WORKSPACE_MOVING' }))).toBe(
      true,
    );
    expect(isTransient(err(409, { error: 'x', reason: 'new', code: 'LABEL_TAKEN' }))).toBe(false);
  });

  it('reads the code off the body: top-level, a nonblank string, or nothing', () => {
    expect(err(409, { error: 'x', code: 'LABEL_TAKEN' }).code).toBe('LABEL_TAKEN');
    expect(err(409, { error: 'x', code: '  ' }).code).toBeUndefined();
    expect(err(409, { error: 'x', code: 7 }).code).toBeUndefined();
    expect(err(409, { error: { code: 'nested' } }).code).toBeUndefined();
    expect(new APIError('x', 409).code).toBeUndefined();
  });
});

describe('what a model is told', () => {
  it('says the code in the error metadata (P2), bounded like the rest', () => {
    const e = err(409, { error: 'x', code: 'LABEL_TAKEN' });
    expect(errorMetadata(e).fields.code).toBe('LABEL_TAKEN');
    expect(textOf(failed(e))).toContain('"code": "LABEL_TAKEN"');
    const long = err(409, { error: 'x', code: 'X'.repeat(129) });
    expect(errorMetadata(long).fields.code).toBeUndefined();
    expect(errorMetadata(long).omitted).toBe(true);
  });

  it('says an unclassified 409 is not known to clear, after the platform’s sentence', () => {
    const text = textOf(failed(err(409, { error: 'The label is taken somewhere.' })));
    expect(text.startsWith('The label is taken somewhere. (HTTP 409) — ')).toBe(true);
    expect(text).toContain('the platform did not say whether this clears');
    // No exception for a sentence that sounds like waiting (Codex, round 4 on
    // #213): only a word or a code makes a 409 one to send again.
    const waiting = textOf(
      failed(err(409, { error: 'Wait until a running command exits before trying again.' })),
    );
    expect(waiting).toContain('do not send it again unchanged.');
    expect(waiting).not.toMatch(/unless the message/);
    // Not on one the platform classified, either way, nor on a 400.
    expect(textOf(failed(err(409, { error: 'x', reason: 'contention' })))).not.toContain(
      'did not say whether this clears',
    );
    expect(textOf(failed(err(409, { error: 'x', reason: 'running' })))).not.toContain(
      'did not say whether this clears',
    );
    expect(textOf(failed(err(400, { error: 'x' })))).not.toContain('did not say');
  });

  it('gives a 403 PUBLIC_URLS_BLOCKED its own advice, not a role or a suspension', () => {
    const text = textOf(failed(err(403, { error: 'x', code: 'PUBLIC_URLS_BLOCKED' })));
    expect(text).toContain('turned public URLs off');
    expect(text).not.toContain('a role that changed or an account suspended');
    // An ordinary 403 keeps the status's own sentence.
    expect(textOf(failed(err(403, { error: 'x' })))).toContain(
      'a role that changed or an account suspended',
    );
  });

  it('names no subject in the advice for unsupported, and says a step can clear it', () => {
    const advice = reasonAdvice('unsupported') ?? '';
    expect(advice).not.toMatch(/this computer|same forever/);
    expect(advice).toContain('needs another step first, which the message names');
  });

  // Codex, round 1 on #213: WORKSPACE_MOVING's "send it again" outranked a
  // permanent word beside it, so a refusal isTransient calls permanent was
  // answered as one to retry.
  it.each(['unavailable', 'running', 'revoked', 'exists'])(
    'defers WORKSPACE_MOVING to a permanent %s beside it',
    (reason) => {
      const e = err(409, { error: 'x', code: 'WORKSPACE_MOVING', reason });
      expect(isTransient(e)).toBe(false);
      const text = textOf(failed(e));
      expect(text).not.toContain('wait a moment and send it again');
      expect(text).not.toContain('clears once the move has finished');
      expect(text).toContain(reasonAdvice(reason) as string);
    },
  );

  // Codex, round 2 on #213: the code's "send it again" was given on a 403
  // and beside a nested word, both of which isTransient calls final.
  it('gives no retry advice for WORKSPACE_MOVING where isTransient says no', () => {
    const cases = [
      errorForStatus(403, 'x', { error: 'x', code: 'WORKSPACE_MOVING' }),
      errorForStatus(401, 'x', { error: 'x', code: 'WORKSPACE_MOVING' }),
      errorForStatus(409, 'x', {
        error: { message: 'x', reason: 'contention' },
        code: 'WORKSPACE_MOVING',
      }),
    ];
    for (const e of cases) {
      expect(isTransient(e), String(e.status)).toBe(false);
      const text = textOf(failed(e));
      expect(text, String(e.status)).not.toContain('wait a moment and send it again');
      expect(text, String(e.status)).not.toContain('clears once the move has finished');
    }
    // A 403 keeps the status's own sentence.
    expect(textOf(failed(cases[0]))).toContain('Retrying does not help');
  });

  // Codex, round 3 on #213: a word that clears was said over a status the
  // predicate calls final, and a code's advice masked the word beside it.
  it('says a clearing word only where the predicate agrees', () => {
    const fiveHundred = err(500, { error: 'x', reason: 'contention' });
    expect(isTransient(fiveHundred)).toBe(false);
    expect(textOf(failed(fiveHundred))).not.toContain('worth sending again');
    const rateLimited = err(429, { error: 'x', reason: 'contention' });
    expect(isTransient(rateLimited)).toBe(true);
    expect(textOf(failed(rateLimited))).toContain('worth sending again');
    expect(textOf(failed(err(409, { error: 'x', reason: 'contention' })))).toContain(
      'worth sending again',
    );
  });

  it('lets a word beside a code speak for itself', () => {
    const taken = err(409, { error: 'x', code: 'LABEL_TAKEN', reason: 'contention' });
    expect(isTransient(taken)).toBe(true);
    expect(textOf(failed(taken))).toContain('worth sending again');
    expect(textOf(failed(taken))).not.toContain('does not clear by waiting');
    const limit = err(409, { error: 'x', code: 'PUBLIC_URL_LIMIT', reason: 'revoked' });
    expect(isTransient(limit)).toBe(false);
    expect(textOf(failed(limit))).not.toContain('update_public_url');
    expect(textOf(failed(limit))).toContain(reasonAdvice('revoked') as string);
  });

  it('gives a code’s advice only on the status it is documented with', () => {
    for (const [code, status] of [
      ['LABEL_TAKEN', 400],
      ['PUBLIC_URL_LIMIT', 403],
      ['PUBLIC_URLS_BLOCKED', 409],
      ['PUBLIC_URLS_DISABLED', 409],
    ] as const) {
      expect(codeAdvice(errorForStatus(status, 'x', { error: 'x', code })), code).toBeUndefined();
    }
  });

  it('keeps WORKSPACE_MOVING’s own advice where the word clears, is unknown, or is absent', () => {
    for (const reason of ['contention', 'some-new-word', undefined]) {
      const e = err(409, { error: 'x', code: 'WORKSPACE_MOVING', reason });
      expect(isTransient(e), String(reason)).toBe(true);
      expect(textOf(failed(e)), String(reason)).toContain('clears once the move has finished');
    }
  });

  it('has advice for each code it classifies, and none for one it does not', () => {
    for (const [code, status] of [
      ['LABEL_TAKEN', 409],
      ['PUBLIC_URL_LIMIT', 409],
      ['PUBLIC_URLS_BLOCKED', 403],
      ['PUBLIC_URLS_DISABLED', 404],
      ['WORKSPACE_MOVING', 409],
    ] as const) {
      expect(codeAdvice(err(status, { error: 'x', code })), code).toBeDefined();
    }
    expect(codeAdvice(err(409, { error: 'x', code: 'SOMETHING_ELSE' }))).toBeUndefined();
  });
});

describe('a keyed call refused as still running', () => {
  let platform: ReturnType<typeof installFakePlatform>;
  beforeEach(() => {
    platform = installFakePlatform();
  });
  afterEach(() => platform.restore());

  const answering = (status: number, body: Record<string, unknown>) => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST')
        return new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });
      return real(input as never, init);
    }) as typeof fetch;
  };

  it('is told to send it again with the same key, as the platform documents', async () => {
    answering(409, { error: 'x', code: 'idempotency_in_progress', reason: 'contention' });
    const { call, close } = await connect();
    const text = textOf(await call('start_computer', { idempotency_key: 'k-1' }));
    await close();
    expect(text).toContain('call again with the same idempotency_key');
  });

  // Codex, round 4 on #213: the code's "send it again with this key" was given
  // beside a permanent word and on another status, both final.
  it.each([
    [409, { error: 'x', code: 'idempotency_in_progress', reason: 'revoked' }],
    [409, { error: 'x', code: 'idempotency_in_progress', reason: 'unsupported' }],
    [403, { error: 'x', code: 'idempotency_in_progress' }],
  ] as const)('is not told to resend a %i that is final: %j', async (status, body) => {
    answering(status, body);
    const { call, close } = await connect();
    const text = textOf(await call('start_computer', { idempotency_key: 'k-1' }));
    await close();
    expect(text).not.toContain('call again with the same idempotency_key');
    expect(text).not.toContain('with idempotency_key "k-1"');
    expect(text).not.toContain('worth sending again');
  });
});

describe('the tools whose refusals carry no word', () => {
  let platform: ReturnType<typeof installFakePlatform>;
  beforeEach(() => {
    platform = installFakePlatform();
  });
  afterEach(() => platform.restore());

  const refusing = (body: Record<string, unknown>) => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST')
        return new Response(JSON.stringify(body), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        });
      return real(input as never, init);
    }) as typeof fetch;
  };

  it.each([
    [
      'create_webhook',
      { url: 'https://ci.example.com/hook' },
      'This account already has 5 of the 5 webhook subscriptions its plan allows; delete one first.',
    ],
    [
      'add_ssh_key',
      { public_key: SSH_PUBLIC_KEY },
      'That key is already registered. A key can belong to one person only.',
    ],
  ])('%s says the platform did not call its 409 passing', async (tool, args, sentence) => {
    refusing({ error: sentence });
    const { call, close } = await connect();
    const text = textOf(await call(tool, args));
    await close();
    expect(text).toContain(sentence);
    expect(text).toContain('the platform did not say whether this clears');
    expect(text).not.toContain('worth sending again');
  });
});
