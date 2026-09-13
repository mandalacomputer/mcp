import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_CLIPBOARD_BYTES,
  WEBHOOK_COMPUTERS_MAX,
  WEBHOOK_DESCRIPTION_MAX,
} from '../src/paths.js';

/**
 * The numbers this server refuses against before spending a round trip,
 * compared with the platform's manifest whenever a checkout is available.
 *
 * Here rather than in scripts/check-surface.mjs, because the script imports
 * the mirror natively and cannot import src/ the same way: these modules use
 * the `.js` specifiers the build emits, which Node's type stripping does not
 * resolve and vitest does. A ceiling that has drifted turns a courtesy refusal
 * into a refusal of a call the platform would have taken, with nothing failing
 * anywhere to say so — which is why they are compared at all.
 */
const LIMITS: [string, number][] = [
  ['clipboard.writeMaxBytes', MAX_CLIPBOARD_BYTES],
  ['webhook.descriptionMaxChars', WEBHOOK_DESCRIPTION_MAX],
  ['webhook.computersMax', WEBHOOK_COMPUTERS_MAX],
];

function platformManifest(): string | undefined {
  const repo = resolve(__dirname, '..');
  const asked = process.env.MANDALA_PLATFORM_REPO
    ? resolve(repo, process.env.MANDALA_PLATFORM_REPO)
    : undefined;
  const candidates = [asked, resolve(repo, '..', 'mandala-computer'), resolve(repo, '..', 'app')]
    .filter((d): d is string => Boolean(d))
    .map((d) => join(d, 'surface-manifest.json'));
  return candidates.find((f) => existsSync(f));
}

describe('the mirrored limits', () => {
  const manifest = platformManifest();
  it.skipIf(!manifest)('are the numbers the platform publishes', () => {
    const { limits } = JSON.parse(readFileSync(manifest as string, 'utf8')) as {
      limits: Record<string, number>;
    };
    for (const [key, mine] of LIMITS) {
      expect(limits[key], key).toBeDefined();
      expect(mine, key).toBe(limits[key]);
    }
  });
});
