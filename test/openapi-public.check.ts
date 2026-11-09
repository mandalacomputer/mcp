import { it } from 'vitest';
import {
  compareCoverage,
  fetchPublishedOpenApi,
  PUBLIC_OPENAPI_URL,
} from '../scripts/check-openapi.mjs';
import { UNIMPLEMENTED } from './allowlist.js';
import { collectExercises, operationEvidence } from './surface-exercise.js';

it('covers every operation in the anonymously published OpenAPI contract', async () => {
  // Fetch and validate first. Failure stops the check before any coverage claim.
  const publication = await fetchPublishedOpenApi();
  // Operations listed as not yet sent (UNIMPLEMENTED) are reported, not failed.
  const summary = compareCoverage(
    publication.contract,
    operationEvidence(await collectExercises()),
    {
      unsent: UNIMPLEMENTED,
      // The retained-object listings land in this mirror before the platform
      // publishes them (OPL-6465). Keep the missing publication visible and
      // time-bounded rather than silently skip it.
      prepublication: ['GET computers/:id/artifacts', 'GET computers/:id/results'].map(
        (operation) => ({ operation, expiresAt: '2026-11-30T00:00:00.000Z' }),
      ),
    },
  );
  console.info(
    JSON.stringify({
      url: PUBLIC_OPENAPI_URL,
      status: publication.status,
      sha256: publication.digest,
      ...summary,
    }),
  );
}, 60_000);
