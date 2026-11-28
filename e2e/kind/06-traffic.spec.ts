import { expect, test, type Page } from '@playwright/test';
import { linesOf } from './lines';
import { edgeLabelsOn, expectFitsPhone, expectMapFitsAndZooms, namespaceTitles, WIDE } from './map';
import { FIGURES_WAIT, IDLE_EDGE } from './traffic';

// atlas-b's client calls server (which server-allow covers), the shop's recommender (which no policy
// covers) and the two servers outside both clusters; recommender may call postgres and never does.

test("the traffic view shows the generator's edges with their figures and marks", async ({ page }) => {
  await page.goto('/traffic/atlas-b');

  for (const edge of [
    /^From client to server, \d+(\.\d)? requests? a second, allowed by a policy$/,
    /^From client to recommender, \d+(\.\d)? requests? a second, covered by no policy$/,
    // Only the HTTP load to outside-http.example, a ServiceEntry host, brings requests to this edge; the TCP
    // load brings bytes alone. So the requests figure fails when the HTTP calls are drawn anywhere else.
    /^From client to Internet, \d+(\.\d)? requests? a second(, .+)?, leaves the cluster: see the Outbound view$/,
  ]) {
    await expect(page.getByLabel(edge)).toBeVisible({ timeout: FIGURES_WAIT });
  }
  await expect(page.getByLabel(IDLE_EDGE, { exact: true })).toBeVisible({ timeout: FIGURES_WAIT });

  const uncovered = page
    .getByRole('region', { name: 'Traffic no policy covers' })
    .getByRole('listitem')
    .filter({ hasText: /^client calls recommender, \d+(\.\d)? requests? a second\./ });
  await expect(uncovered).toContainText('No policy restricts calls out of client or into recommender.');
  await expect(page.getByRole('navigation', { name: 'Views' })).toContainText('Prometheus, 1 of 1');
});

test('the cluster with no Prometheus says "no traffic source"', async ({ page }) => {
  await page.goto('/traffic/atlas-a');

  await expect(page.getByText('No traffic source for atlas-a: its registry entry names no Prometheus.', { exact: true })).toBeVisible();
});

// Laid out top to bottom, the map fits at a scale its names can be read at without zooming.
test('at 1440 by 900 the whole traffic map fits its box at 60% or more, and Zoom In enlarges it', async ({ page }) => {
  expect(await expectMapFitsAndZooms(page, '/traffic/atlas-b')).toBeGreaterThanOrEqual(0.6);
});

/** Every text an edge label can show: its figures (`2 req/s · 2.1% errors`, `48 B/s`), how long nothing was seen, or that nothing is measured. */
const EDGE_LABEL = /^(no traffic, (24 h|5 min)|not measured|.*(req\/s|B\/s|% errors))$/;

/**
 * Opens atlas-b's traffic map at 1440 by 900 once its figures are on its edges: they are the labels' texts, which
 * set the labels' places. The edge is named by its mark too: a call that failed while recommender was starting
 * draws a second edge from client to a box named recommender, the service nobody answered, which no policy is
 * compared with.
 */
async function openWithFigures(page: Page): Promise<void> {
  await page.setViewportSize(WIDE);
  await page.goto('/traffic/atlas-b');
  await expect(page.getByLabel(/^From client to recommender, .*, covered by no policy$/)).toBeVisible({ timeout: FIGURES_WAIT });
  await expect(page.getByLabel(IDLE_EDGE, { exact: true })).toBeVisible({ timeout: FIGURES_WAIT });
}

test('at 1440 by 900 no edge label lies on a workload box', async ({ page }) => {
  await openWithFigures(page);
  expect((await edgeLabelsOn(page, EDGE_LABEL)).boxes).toStrictEqual([]);
});

test('at 1440 by 900 no edge label lies on a namespace title', async ({ page }) => {
  await openWithFigures(page);
  expect((await edgeLabelsOn(page, EDGE_LABEL)).titles).toStrictEqual([]);
});

test('at 1440 by 900 every namespace title is on one line', async ({ page }) => {
  await openWithFigures(page);
  // atlas-b's own titles; a namespace a stopped run left behind is drawn too, and is not this row's.
  expect(await linesOf(namespaceTitles(page))).toEqual(
    expect.arrayContaining([
      ['namespace ingress', 1],
      ['namespace local-path-storage', 1],
      ['namespace payments', 1],
      ['namespace shop', 1],
      ['namespace traffic', 1],
    ]),
  );
});

test('on a 375 pixel screen the traffic page scrolls no wider than the screen, and its map is scaled down to fit', async ({ page }) => {
  await expectFitsPhone(page, '/traffic/atlas-b');
});

test('the traffic map has a name for assistive technology', async ({ page }) => {
  await page.goto('/traffic/atlas-b');

  await expect(page.getByRole('application', { name: 'Traffic map of atlas-b', exact: true })).toBeVisible();
});

// Compare with policies is on unless the URL says compare=0. Off, an edge says only what was measured, the
// idle edges (which have nothing measured) are left out, and the legend has one line.
test('Compare with policies turns the marks off and on again through the URL', async ({ page }) => {
  await page.goto('/traffic/atlas-b');
  const toServerMarked = page.getByLabel(/^From client to server, \d+(\.\d)? requests? a second, allowed by a policy$/);
  await expect(toServerMarked).toBeVisible({ timeout: FIGURES_WAIT });
  await expect(page.getByLabel(IDLE_EDGE, { exact: true })).toBeVisible({ timeout: FIGURES_WAIT });

  await page.getByRole('button', { name: 'Compare with policies', pressed: true }).click();
  await expect(page).toHaveURL(/\/traffic\/atlas-b\?compare=0$/);
  await expect(page.getByRole('button', { name: 'Compare with policies', pressed: false })).toBeVisible();
  await expect(page.getByLabel(/^From client to server, \d+(\.\d)? requests? a second$/)).toBeVisible();
  await expect(page.getByLabel(IDLE_EDGE, { exact: true })).toHaveCount(0);
  await expect(page.getByText('traffic seen', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Compare with policies', pressed: false }).click();
  await expect(page).toHaveURL(/\/traffic\/atlas-b$/);
  await expect(toServerMarked).toBeVisible();
});
