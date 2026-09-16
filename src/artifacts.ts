import { createHash } from 'node:crypto';
import type { BoundedBytes } from './api.js';
import {
  binaryContent,
  digest,
  executionId,
  integer,
  record,
  requireValue,
  scopeId,
  time,
} from './results.js';
export const artifactId = (v: unknown): v is string =>
  typeof v === 'string' && v.length === 36 && /^art_[a-f0-9]{32}$/.test(v);
export type ArtifactOptions = {
  path: string;
  expected_size: number;
  expected_sha256: string;
  execution_id?: string;
  max_bytes?: number;
  retention_seconds?: number;
};
export function artifactOptions(v: unknown): ArtifactOptions {
  requireValue(
    record(v) &&
      Object.keys(v).every((k) =>
        [
          'path',
          'expected_size',
          'expected_sha256',
          'execution_id',
          'max_bytes',
          'retention_seconds',
        ].includes(k),
      ),
  );
  const path = v.path;
  requireValue(
    typeof path === 'string' &&
      path.length > 0 &&
      Buffer.byteLength(path) <= 4096 &&
      ![...path].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127),
  );
  requireValue(
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(path),
  );
  requireValue(path.startsWith('/') || path.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(path));
  requireValue(integer(v.expected_size, 0, 64 * 1024 * 1024) && digest(v.expected_sha256));
  if ('max_bytes' in v) requireValue(integer(v.max_bytes, 1, 64 * 1024 * 1024));
  if ('retention_seconds' in v) requireValue(integer(v.retention_seconds, 1, 604800));
  if ('execution_id' in v) requireValue(executionId(v.execution_id));
  requireValue(v.expected_size <= ((v.max_bytes as number) ?? 8 * 1024 * 1024));
  return v as ArtifactOptions;
}
export function artifactMetadata(
  v: unknown,
  computer: string,
  id?: string,
  nomination?: ArtifactOptions,
) {
  requireValue(
    record(v) &&
      artifactId(v.artifact_id) &&
      (!id || v.artifact_id === id) &&
      v.kind === 'artifact' &&
      v.state === 'ready' &&
      v.computer_id === computer &&
      scopeId(v.computer_id) &&
      (v.workspace_id === null || scopeId(v.workspace_id)) &&
      integer(v.size, 0, 64 * 1024 * 1024) &&
      digest(v.sha256),
  );
  const created = time(v.created_at),
    expires = time(v.expires_at);
  requireValue(expires > created && expires - created <= 604800000000000n);
  let association = null;
  if (v.execution_association !== null) {
    const a = v.execution_association;
    requireValue(
      record(a) &&
        a.kind === 'caller_selected' &&
        executionId(a.execution_id) &&
        time(a.verified_at) <= created,
    );
    association = {
      kind: 'caller_selected',
      execution_id: a.execution_id,
      verified_at: a.verified_at,
    };
  }
  if (nomination)
    requireValue(
      v.size === nomination.expected_size &&
        v.sha256 === nomination.expected_sha256 &&
        (association?.execution_id ?? undefined) === nomination.execution_id,
    );
  return {
    artifact_id: v.artifact_id,
    kind: 'artifact',
    state: 'ready',
    computer_id: v.computer_id,
    workspace_id: v.workspace_id,
    created_at: v.created_at,
    expires_at: v.expires_at,
    size: v.size,
    sha256: v.sha256,
    execution_association: association,
  };
}
export function artifactContent(v: BoundedBytes, manifest: ReturnType<typeof artifactMetadata>) {
  requireValue(
    v.headers['content-type']?.split(';')[0].trim().toLowerCase() === 'application/octet-stream' &&
      v.headers['content-length'] === String(manifest.size) &&
      v.bytes.length === manifest.size,
  );
  requireValue(createHash('sha256').update(v.bytes).digest('hex') === manifest.sha256);
  return { ...manifest, verified: true, ...binaryContent(v.bytes) };
}
