import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The same `@/*` alias tsconfig.json maps, so tests import modules by the names the code uses.
const alias = { '@': fileURLToPath(new URL('./src', import.meta.url)) };

export default defineConfig({
  test: {
    projects: [
      { resolve: { alias }, test: { name: 'unit', include: ['src/**/*.test.ts'], environment: 'node' } },
      // What the release publishes: the chart, and the release's own checks.
      { resolve: { alias }, test: { name: 'package', include: ['test/chart/**/*.test.ts', 'test/release/**/*.test.ts'], environment: 'node' } },
    ],
  },
});
