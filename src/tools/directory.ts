import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { APIError } from '../errors.js';
import { failed, said } from '../format.js';
import * as P from '../paths.js';
import { computerSchema, readAnnotations } from './results.js';
import type { Registrar } from './types.js';

export const count = z.number().int().nonnegative().safe();
export const label = z.string().min(1);
export const exitCode = z.number().int().min(-2147483648).max(2147483647);
export const executionId = z.string().regex(/^exec_[a-f0-9]{32}$/);

/** Strip unknown fields and never print a schema exception containing response values. */
export function metadata<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new Error('Malformed metadata response; no complete result was established.');
  return parsed.data;
}

/** Shared only by the passive metadata tools. No retry or readiness side effects. */
export async function metadataCall(work: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof APIError)) return failed(error);
    const fields = z
      .object({
        code: z.string().optional(),
        reason: z.string().optional(),
        incomplete: z.boolean().optional(),
      })
      .safeParse(error.body);
    const detail = fields.success ? fields.data : {};
    const nested = (error.body as { error?: unknown } | undefined)?.error;
    const refusal = failed(
      new APIError(
        error.message,
        error.status,
        { ...detail, reason: error.reason },
        error.retryAfterMs,
        error,
      ),
      nested === null || typeof nested !== 'object' || Array.isArray(nested),
    );
    return {
      ...refusal,
      content: [
        ...refusal.content,
        ...said('Refusal metadata:', {
          code: detail.code,
          incomplete: detail.incomplete,
          ...(error.retryAfterMs === undefined ? {} : { retry_after_ms: error.retryAfterMs }),
        }).content,
      ],
    };
  }
}

const directorySchema = z.object({
  path: label,
  entries: z
    .array(
      z
        .object({
          name: label,
          type: z.enum(['file', 'directory', 'symlink', 'special', 'unavailable']),
          size_bytes: count.optional(),
        })
        .refine(
          (entry) => entry.type === 'file' || entry.size_bytes === undefined,
          'Only regular files may report size_bytes',
        ),
    )
    .max(512),
  truncated: z.boolean(),
  skipped: count,
});

export const registerDirectory: Registrar = (server, session) => {
  server.registerTool(
    'list_directory',
    {
      title: 'List a guest directory without waking it',
      description:
        'Read one passive, unordered directory listing from an already running computer. No resume or idle extension; ordinary API rate/capacity admission still applies. At most 512 examined entries/128 KiB, with no continuation token. Narrow the path when partial. Symlinks are not followed; a final symlink directory is refused. No file content is read.',
      inputSchema: {
        computer_id: computerSchema,
        path: z
          .string()
          .startsWith('/')
          .refine(
            (path) =>
              ![...path].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) &&
              !P.hasUnpairedSurrogate(path),
            'path must be an exact usable absolute guest path',
          ),
      },
      annotations: readAnnotations,
    },
    ({ computer_id, path }, extra) =>
      metadataCall(async () => {
        const data = metadata(
          directorySchema,
          await session.api.json('GET', P.directory(session.resolve(computer_id)), {
            query: { path },
            signal: extra.signal,
          }),
        );
        if (data.path !== path)
          throw new Error('Directory response did not match the requested path.');
        return said(
          data.truncated || data.skipped > 0
            ? 'PARTIAL directory listing: entries or names were omitted. This is an unordered subset with no continuation token; use a narrower path.'
            : 'Directory metadata only. An unavailable entry has no inferred type or size; symlinks are not followed.',
          data,
        );
      }),
  );
};
