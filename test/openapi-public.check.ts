import { it } from 'vitest';
import {
  compareCoverage,
  fetchPublishedOpenApi,
  PUBLIC_OPENAPI_URL,
} from '../scripts/check-openapi.mjs';
import { collectExercises, operationEvidence } from './surface-exercise.js';

it('covers every operation in the anonymously published OpenAPI contract', async () => {
  // Fetch and validate first. Failure stops the check before any coverage claim.
  const publication = await fetchPublishedOpenApi();
  const summary = compareCoverage(
    publication.contract,
    operationEvidence(await collectExercises()),
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
