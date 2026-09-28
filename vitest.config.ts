import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/shared', 'packages/core', 'packages/simulator', 'apps/server', 'apps/web'],
  },
});
