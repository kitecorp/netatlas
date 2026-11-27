import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const PORT = 3100;
// Playwright loads this file as CommonJS, so __dirname is the project root.
const clustersFile = join(__dirname, 'e2e/fixtures/clusters-unreachable.yaml');

export default defineConfig({
  // Only the journeys against the built server; the kind journeys live elsewhere and need clusters.
  testDir: 'e2e/standalone',
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run start:standalone',
    // The page answers as soon as the server listens; /api/health answers 503 until register() has run.
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { PORT: String(PORT), HOSTNAME: '127.0.0.1', NETATLAS_CLUSTERS_FILE: clustersFile },
  },
});
