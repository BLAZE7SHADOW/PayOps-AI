import { defineProject } from 'vitest/config';
export default defineProject({
  test: { name: 'evals', environment: 'node', testTimeout: 30_000, hookTimeout: 30_000 },
});
