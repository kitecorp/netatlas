import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';

// Runs last: it stops atlas-b's only node, and scripts/e2e/up.sh starts it again.
test('a stopped cluster shows as unreachable with the age of its data, without a reload', async ({ page }) => {
  // docker stop waits up to 10 s for the node, then the page has 60 s.
  test.setTimeout(150_000);
  await page.goto('/');
  const row = page.getByRole('row', { name: /^atlas-b/ });
  await expect(row.getByRole('cell').nth(6)).toHaveText('sidecars', { timeout: 30_000 });

  execFileSync('docker', ['stop', 'atlas-b-control-plane'], { stdio: 'ignore' });

  // The page is not reloaded: the change stream renders it again once a probe fails.
  await expect(row).toHaveText(
    /^atlas-bUnreachable since \d\d:\d\d: the API server stopped answering\. Showing data from (\d+ seconds|1 minute) ago: 18 workloads, 8 policies\.(\d+ s|1 min) ago$/,
    { timeout: 60_000 },
  );
});
