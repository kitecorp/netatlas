import { defineConfig } from '@playwright/test';
import kind from './playwright.kind.config';

// The README's pictures (npm run screenshots), taken against the kind clusters through the kind journeys'
// own port-forward and settings, so they can be taken again for each release. A config of their own keeps
// npm run e2e:kind from taking them.
export default defineConfig({
  ...kind,
  testDir: 'e2e/screenshots',
  projects: [{ name: 'screenshots' }],
});
