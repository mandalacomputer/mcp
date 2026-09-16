import { z } from 'zod';
import { said } from '../format.js';
import * as P from '../paths.js';
import {
  PRESENTATION_DEFAULT,
  PRESENTATION_MAX,
  requireValue,
  resultMetadata,
  resultPage,
  resultQuery,
  retainedCall,
  retainOptions,
  scopeId,
} from '../results.js';
import type { Registrar } from './types.js';
export const retentionSchema = z
  .object({
    max_bytes_per_stream: z
      .number()
      .int()
      .min(1)
      .max(4 * 1024 * 1024)
      .optional(),
    retention_seconds: z.number().int().min(1).max(604800).optional(),
  })
  .strict();
export const computerSchema = z
  .string()
  .min(1)
  .max(100)
  .optional()
  .describe('Computer, or the current use_computer selection.');
export const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
export const captureAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
};
export const deleteAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
};
const identity = {
  computer_id: computerSchema,
  result_id: z
    .string()
    .length(36)
    .regex(/^res_[a-f0-9]{32}$/),
};
export const registerResults: Registrar = (server, session) => {
  server.registerTool(
    'retain_execution_output',
    {
      title: 'Retain an explicit execution output version',
      description:
        'Capture one immutable prefix version from volatile guest output by stable execution_id. Explicit guest I/O; never resumes, retries or replays a command. Each call creates a separate version. Capture may commit even if its response is lost. Default 1 MiB per stream/max 4 MiB and default 86400s/max 604800s retention; diagnostics separately capped 64 KiB.',
      inputSchema: {
        computer_id: computerSchema,
        execution_id: z
          .string()
          .length(37)
          .regex(/^exec_[a-f0-9]{32}$/),
        ...retentionSchema.shape,
      },
      annotations: captureAnnotations,
    },
    ({ computer_id, execution_id, max_bytes_per_stream, retention_seconds }, extra) =>
      retainedCall(extra.signal, true, async (signal) => {
        const id = session.resolve(computer_id);
        requireValue(scopeId(id));
        const body = retainOptions({
          ...(max_bytes_per_stream === undefined ? {} : { max_bytes_per_stream }),
          ...(retention_seconds === undefined ? {} : { retention_seconds }),
        });
        const data = await session.api
          .with(signal)
          .boundedJson('POST', P.retainedOutput(id, execution_id), 8192, 201, { body });
        return said(
          'Immutable retained version; readiness does not establish command success or complete guest output.',
          resultMetadata(data, id, undefined, execution_id, body),
        );
      }),
  );
  server.registerTool(
    'get_result',
    {
      title: 'Read retained result metadata',
      description:
        'Read one immutable result manifest without guest output/files, resume, capture or command replay. Expiry, current scope or storage availability can make a version unavailable.',
      inputSchema: identity,
      annotations: readAnnotations,
    },
    ({ computer_id, result_id }, extra) =>
      retainedCall(extra.signal, false, async (signal) => {
        const id = session.resolve(computer_id);
        requireValue(scopeId(id));
        return said(
          'Immutable retained metadata; retained and upstream truncation are separate.',
          resultMetadata(
            await session.api.with(signal).boundedJson('GET', P.result(id, result_id), 8192, 200),
            id,
            result_id,
          ),
        );
      }),
  );
  server.registerTool(
    'read_result_output',
    {
      title: 'Read an independent retained byte page',
      description:
        'Read one passive retained stdout, stderr or diagnostic page at an explicit offset. Default 4096/max 16384 bytes. EOF concerns this immutable prefix, not task completion. Lossless UTF-8/BOM or exact base64; no guest read, shared cursor, implicit capture, iteration or replay.',
      inputSchema: {
        ...identity,
        stream: z.enum(['stdout', 'stderr', 'diagnostic']),
        offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        limit: z.number().int().min(1).max(PRESENTATION_MAX).default(PRESENTATION_DEFAULT),
      },
      annotations: readAnnotations,
    },
    ({ computer_id, result_id, stream, offset, limit }, extra) =>
      retainedCall(extra.signal, false, async (signal) => {
        const id = session.resolve(computer_id);
        requireValue(scopeId(id));
        const query = resultQuery(stream, offset, limit);
        const response = await session.api
          .with(signal)
          .boundedBytes('GET', P.resultOutput(id, result_id), limit, 200, { query });
        return said(
          'One independent immutable byte page; no full-stream hash claim.',
          resultPage(response, result_id, query),
        );
      }),
  );
  server.registerTool(
    'delete_result',
    {
      title: 'Delete a retained output version',
      description:
        'Delete exactly this immutable result version. No metadata preflight or guest mutation. Same deletion effect on repeat, but a repeated 404 remains unavailable; no automatic retry.',
      inputSchema: identity,
      annotations: deleteAnnotations,
    },
    ({ computer_id, result_id }, extra) =>
      retainedCall(extra.signal, true, async (signal) => {
        const id = session.resolve(computer_id);
        requireValue(scopeId(id));
        await session.api.with(signal).boundedBytes('DELETE', P.result(id, result_id), 0, 204);
        return said('Retained result deleted.', { result_id, deleted: true });
      }),
  );
};
