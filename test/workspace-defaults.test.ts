import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CredentialsError, parseWorkspaceDefaults } from '../src/credentials.js';

/**
 * ~/.mandala/defaults.json, as `mandala workspaces use` writes it (OPL-5499).
 * The vectors are the same bytes the TypeScript and Python CLIs test against.
 */
type Vectors = {
  valid: {
    name: string;
    text: string;
    lookups: {
      profile: string;
      account_id: string;
      entry: { id: string; name: string } | null;
      ignored: { id: string; name: string } | null;
    }[];
  }[];
  invalid: { name: string; text: string; code: string }[];
};
const vectors: Vectors = JSON.parse(
  fs.readFileSync(new URL('./fixtures/defaults-v1.json', import.meta.url), 'utf8'),
);

describe('defaults.json', () => {
  it.each(vectors.valid)('reads the shared vector: $name', ({ text, lookups }) => {
    const profiles = parseWorkspaceDefaults(new TextEncoder().encode(text));
    for (const l of lookups) {
      const saved = Object.hasOwn(profiles, l.profile) ? profiles[l.profile] : undefined;
      const matches = saved?.account_id === l.account_id;
      expect(saved && matches ? saved.workspace : null).toEqual(l.entry);
      expect(saved && !matches ? saved.workspace : null).toEqual(l.ignored);
    }
  });

  it.each(vectors.invalid)('refuses the shared vector: $name', ({ text, code }) => {
    let error: unknown;
    try {
      parseWorkspaceDefaults(new TextEncoder().encode(text));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CredentialsError);
    expect((error as CredentialsError).code).toBe(code);
  });
});
