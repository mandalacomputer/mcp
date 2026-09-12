import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `plans/` is a local, git-ignored scratch area holding one full worktree
    // per past audit batch, each with its own copy of this suite. Vitest's
    // default include walks into them, so a bare `vitest run` at the root
    // collected 270 files and 9577 tests — nine minutes of mostly historical
    // duplicates, and a pass that says nothing about this tree. CI clones
    // clean and never saw it; this is for the working copy.
    exclude: ['**/node_modules/**', '**/dist/**', 'plans/**'],
  },
});
