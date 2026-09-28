import { defineProject } from 'vitest/config';
export default defineProject({ test: { name: 'simulator', environment: 'node', testTimeout: 30_000 } });
