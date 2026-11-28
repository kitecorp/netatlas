import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { expectMapFits, WIDE } from '../kind/map';
import { FIGURES_WAIT, IDLE_EDGE } from '../kind/traffic';

// The pictures the README shows, written to docs/screenshots/ and committed. Each waits until its page shows what
// the picture is of, so a page still loading fails here rather than being committed. The views are of atlas-b,
// the cluster with the example shop, Istio and traffic. The app has one theme, and a scale of 2 keeps the text
// sharp on a high-density screen.
test.use({ viewport: WIDE, deviceScaleFactor: 2 });

// Playwright loads this file as CommonJS, so __dirname is this folder.
const picture = (name: string) => join(__dirname, '../../docs/screenshots', name);

/** A picture of the first screen, or of the whole page for a map, which is taller than a screen. */
const take = (page: Page, name: string, fullPage = false) => page.screenshot({ path: picture(name), fullPage });

test('overview.png: the overview of both clusters', async ({ page }) => {
  await page.goto('/');

  for (const cluster of ['atlas-a', 'atlas-b']) {
    await expect(page.getByRole('row', { name: new RegExp(`^${cluster}`) }).getByRole('cell').last()).toHaveText(/^\d+ s ago$/, { timeout: 30_000 });
  }
  await expect(page.getByRole('navigation', { name: 'Views' })).toContainText('Kubernetes API, 2 of 2');
  await take(page, 'overview.png');
});

test("map.png: atlas-b's policy map", async ({ page }) => {
  await expectMapFits(page, '/map/atlas-b');
  // React Flow hides an edge's label until it has sized the label's background in the browser.
  await expect(page.getByText('TCP 5432', { exact: true }).first()).toBeVisible();
  await take(page, 'map.png', true);
});

test("traffic.png: atlas-b's traffic with figures on its edges", async ({ page }) => {
  await expectMapFits(page, '/traffic/atlas-b');
  await expect(page.getByLabel(/^From client to server, \d+(\.\d)? requests? a second, allowed by a policy$/)).toBeVisible({ timeout: FIGURES_WAIT });
  await expect(page.getByLabel(IDLE_EDGE, { exact: true })).toBeVisible({ timeout: FIGURES_WAIT });
  await take(page, 'traffic.png', true);
});

test("outbound.png: atlas-b's destinations outside the cluster with their callers", async ({ page }) => {
  await page.goto('/outbound/atlas-b');

  // A row's last cell, Do call, lists the workloads that call it, each with its figure: requests, or bytes for TCP.
  for (const row of [/^outside-http\.example/, /^Unregistered TLS or TCP traffic/]) {
    await expect(page.getByRole('row', { name: row }).getByRole('cell').last()).toHaveText(/traffic \/ client\s*(\d+(\.\d)? (req|B|kB)\/s|< 1 B\/s)/, { timeout: FIGURES_WAIT });
  }
  await take(page, 'outbound.png');
});
