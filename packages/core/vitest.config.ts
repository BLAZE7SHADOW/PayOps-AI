import { defineProject } from 'vitest/config';
export default defineProject({
  test: { name: 'core', environment: 'node', setupFiles: ['./src/testing/setup.ts'], testTimeout: 20_000 },
});
