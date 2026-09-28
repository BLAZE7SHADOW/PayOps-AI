import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/shared', 'packages/core', 'packages/simulator', 'packages/agents', 'apps/server', 'apps/web'],
  },
});
