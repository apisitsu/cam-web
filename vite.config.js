import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Standalone dev server on 3100. When imported into EngineerSystem later this
// config is dropped in favour of that monorepo's build; the /api proxy points
// at the ENG-Backend port to smooth that transition.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3100,
    proxy: {
      '/api': 'http://localhost:2005',
    },
  },
  worker: {
    format: 'es', // Comlink workers use ES modules
  },
  build: {
    target: 'es2022',
    // WASM kernels (OCCT ~30MB) arrive in later phases — keep Phase 0 light.
    chunkSizeWarningLimit: 4096,
  },
  test: {
    // Engine and store suites are plain Node. Component suites opt into a DOM
    // per file with `@vitest-environment jsdom`, so the fast majority stays fast.
    environment: 'node',
    // R3F's test renderer builds a real scene graph without WebGL; three's
    // ESM build needs to be transformed rather than externalised for that.
    server: { deps: { inline: [/@react-three/] } },
  },
});
