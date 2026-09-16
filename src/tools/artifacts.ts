import { z } from 'zod';
import { artifactContent, artifactMetadata, artifactOptions } from '../artifacts.js';
import { refused, said } from '../format.js';
import * as P from '../paths.js';
import {
  PRESENTATION_DEFAULT,
  PRESENTATION_MAX,
  requireValue,
  retainedCall,
  scopeId,
} from '../results.js';
import {
  captureAnnotations,
  computerSchema,
  deleteAnnotations,
  readAnnotations,
} from './results.js';
import type { Registrar } from './types.js';

const identity = {
  computer_id: computerSchema,
  artifact_id: z
    .string()
    .length(36)
    .regex(/^art_[a-f0-9]{32}$/),
};
export const registerArtifacts: Registrar = (server, session) => {
  server.registerTool(
    'publish_artifact',
    {
      title: 'Publish a nominated immutable file version',
      description:
        'Explicitly capture a caller-nominated absolute Linux, Windows drive or UNC file path with expected_size and lowercase expected_sha256 already supplied. One guest file read, no preflight stat/list/hash/exec. Optional execution_id is verified caller-selected association, not proof of authorship. Default 8 MiB/max 64 MiB capture cap; default 86400s/max 604800s retention. New version per call; a lost response leaves publication unconfirmed.',
      inputSchema: {
        computer_id: computerSchema,
        path: z.string().min(1),
        expected_size: z
          .number()
          .int()
          .min(0)
          .max(64 * 1024 * 1024),
        expected_sha256: z
          .string()
          .length(64)
          .regex(/^[a-f0-9]{64}$/),
        execution_id: z
          .string()
          .length(37)
          .regex(/^exec_[a-f0-9]{32}$/)
          .optional(),
        max_bytes: z
          .number()
          .int()
          .min(1)
          .max(64 * 1024 * 1024)
          .optional(),
        retention_seconds: z.number().int().min(1).max(604800).optional(),
      },
      annotations: captureAnnotations,
    },
    ({ computer_id, ...args }, extra) =>
      retainedCall(extra.signal, true, async (signal) => {
        const id = session.resolve(computer_id);
        requireValue(scopeId(id));
        const body = artifactOptions(
          Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined)),
        );
        const data = await session.api
          .with(signal)
          .boundedJson('POST', P.artifacts(id), 4096, 201, { body });
        return said(
          'Immutable nominated file version; association records caller selection.',
          artifactMetadata(data, id, undefined, body),
        );
      }),
  );
  server.registerTool(
    'get_artifact',
    {
      title: 'Read immutable artifact metadata',
      description:
        'Passive finite metadata for one retained artifact. No guest file or execution lookup, resume, capture or fallback.',
      inputSchema: identity,
      annotations: readAnnotations,
    },
    ({ computer_id, artifact_id }, extra) =>
      retainedCall(extra.signal, false, async (signal) => {
        const id = session.resolve(computer_id);
        requireValue(scopeId(id));
        return said(
          'Immutable artifact metadata.',
          artifactMetadata(
            await session.api
              .with(signal)
              .boundedJson('GET', P.artifact(id, artifact_id), 4096, 200),
            id,
            artifact_id,
          ),
        );
      }),
  );
  server.registerTool(
    'read_artifact',
    {
      title: 'Read a complete verified small artifact',
      description:
        'Read metadata, then only if the complete artifact fits max_bytes (default 4096/max 16384), read the whole immutable object and verify size/SHA-256. Over cap returns metadata only, with zero content GETs. One 90s operation budget; no Range, prefix, assembly, file destination, guest fallback or image/HTML rendering. Lossless UTF-8/BOM or exact base64.',
      inputSchema: {
        ...identity,
        max_bytes: z.number().int().min(1).max(PRESENTATION_MAX).default(PRESENTATION_DEFAULT),
      },
      annotations: readAnnotations,
    },
    ({ computer_id, artifact_id, max_bytes }, extra) =>
      retainedCall(extra.signal, false, async (signal) => {
        const id = session.resolve(computer_id);
        requireValue(scopeId(id));
        const api = session.api.with(signal);
        const metadata = artifactMetadata(
          await api.boundedJson('GET', P.artifact(id, artifact_id), 4096, 200),
          id,
          artifact_id,
        );
        if (metadata.size > max_bytes)
          return refused(
            'Artifact exceeds the complete-content presentation cap. No content was downloaded or hash verified; use an SDK whole download with an adequate cap.',
            metadata,
          );
        if (signal.aborted) throw signal.reason;
        const response = await api.boundedBytes(
          'GET',
          P.artifactDownload(id, artifact_id),
          metadata.size,
          200,
        );
        return said(
          'Complete retained artifact verified against its immutable size and SHA-256.',
          artifactContent(response, metadata),
        );
      }),
  );
  server.registerTool(
    'delete_artifact',
    {
      title: 'Delete an immutable artifact version',
      description:
        'Delete exactly this retained artifact, without metadata preflight or guest file deletion. Same deletion effect on repeat; repeated 404 remains unavailable. No retry.',
      inputSchema: identity,
      annotations: deleteAnnotations,
    },
    ({ computer_id, artifact_id }, extra) =>
      retainedCall(extra.signal, true, async (signal) => {
        const id = session.resolve(computer_id);
        requireValue(scopeId(id));
        await session.api.with(signal).boundedBytes('DELETE', P.artifact(id, artifact_id), 0, 204);
        return said('Retained artifact deleted.', { artifact_id, deleted: true });
      }),
  );
};
