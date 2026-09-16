import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['test/openapi-public.check.ts'], testTimeout: 60_000 },
});
