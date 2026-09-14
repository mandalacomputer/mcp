/**
 * Types for the two constants the suite reads out of `check-surface.mjs`.
 *
 * The script is plain JavaScript — it runs under bare `node` with no build
 * step, which is the point of it. This exists so `test/check-surface.test.ts`
 * can import MARKER and MANIFEST rather than spelling them again: one of them
 * names a platform module, and `check-internals` refuses those in this repo's
 * published tree.
 *
 * Deliberately not a declaration of the whole module. Nothing else in it is
 * anybody's to import, and a type for `main` would invite somebody to call it.
 */

/** The file whose presence identifies a platform checkout. */
export const MARKER: string;

/** The platform's generated surface inventory, relative to its repo root. */
export const MANIFEST: string;
