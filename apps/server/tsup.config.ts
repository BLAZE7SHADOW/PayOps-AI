import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  clean: true,
  splitting: false,
  noExternal: ['@payops/shared', '@payops/core', '@payops/simulator', '@payops/agents'],
});
