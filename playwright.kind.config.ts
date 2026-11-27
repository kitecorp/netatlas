import { defineConfig, devices } from '@playwright/test';

const PORT = 3000;

// A failed test gets an error-context.md with an aria snapshot of the page, which the HTML report CI
// uploads keeps, and that snapshot shows a password field's value: the Apply journey's token. This
// variable turns that snapshot off (read in node_modules/playwright/lib/index.js, _takePageSnapshot, at
// 1.65.0). It is set here, before any worker starts, so every run of these journeys has it.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';

// The journeys against netatlas installed by its chart in two kind clusters (scripts/e2e/up.sh and
// install.sh). They share the clusters and change them, so they run one at a time and in order; the
// journey that stops atlas-b runs last.
export default defineConfig({
  testDir: 'e2e/kind',
  workers: 1,
  // The first read of a cluster can take a while after an install, and the unreachable journey waits for a probe.
  timeout: 90_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { ...devices['Desktop Chrome'], baseURL: `http://127.0.0.1:${PORT}`, trace: 'retain-on-failure' },
  projects: [
    { name: 'kind', testMatch: /\/0[^/]*\.spec\.ts$/ },
    { name: 'kind-last', testMatch: /\/99-[^/]*\.spec\.ts$/, dependencies: ['kind'] },
  ],
  webServer: {
    command: `kubectl --context kind-atlas-a -n netatlas port-forward svc/netatlas ${PORT}:80`,
    // /api/health answers 200 once register() has read the registry.
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
