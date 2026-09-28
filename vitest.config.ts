import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/shared', 'packages/core', 'packages/simulator', 'packages/agents', 'packages/evals', 'apps/server', 'apps/web'],
  },
});
