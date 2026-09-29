import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const API_TARGET = 'http://localhost:4000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Pre-bundle heavy deps up front so the dev server serves a few files instead of
  // hundreds of unbundled modules (this is what inflated the dev Lighthouse run).
  optimizeDeps: {
    include: [
      'recharts',
      'zod',
      'socket.io-client',
      '@tanstack/react-query',
      '@radix-ui/react-icons',
      '@radix-ui/react-dialog',
      '@radix-ui/react-dropdown-menu',
      '@radix-ui/react-popover',
      '@radix-ui/react-select',
      '@radix-ui/react-tabs',
      '@radix-ui/react-tooltip',
    ],
  },
  server: {
    // Transform the entry and overview route ahead of the first request.
    warmup: { clientFiles: ['./src/main.tsx', './src/app/*.tsx', './src/features/overview/*.tsx'] },
    port: 5173,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      '/socket.io': { target: API_TARGET, ws: true, changeOrigin: true },
    },
  },
  build: {
    sourcemap: true,
    rollupOptions: {
      output: {
        // Long-lived vendor chunks so app changes do not bust the framework cache.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (/[\\/](recharts|d3-|victory-vendor)/.test(id)) return 'charts';
          if (/[\\/](react|react-dom|react-router|scheduler)[\\/]/.test(id)) return 'react';
          if (id.includes('@radix-ui') || id.includes('@floating-ui')) return 'radix';
          return 'vendor';
        },
      },
    },
  },
});
