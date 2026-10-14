import { defineConfig } from 'vitest/config';

// Relative base so the build works on GitHub Pages project sites (/<repo>/) and from any static host.
export default defineConfig({
  base: './',
  build: {
    // Chrome 103 / Firefox 115 ESR are the oldest browsers with every API we rely on
    // (WebGL2, module workers, DecompressionStream('deflate-raw'), IndexedDB Blobs).
    target: ['chrome103', 'firefox115'],
    sourcemap: true,
  },
  worker: {
    format: 'es',
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    testTimeout: 120_000,
  },
});
