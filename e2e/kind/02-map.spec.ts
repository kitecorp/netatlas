import { expect, test } from '@playwright/test';
import { edgeLabelsOn, expectFitsPhone, expectMapFits, expectMapFitsAndZooms, titlesUnderLines, WIDE } from './map';

test('opening a cluster from the overview shows its map', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'atlas-b', exact: true }).click();

  await expect(page).toHaveURL(/\/map\/atlas-b$/);
  for (const edge of [
    'From Internet to gateway, TCP 443, allowed by a NetworkPolicy',
    'From frontend to cart, TCP 8080, allowed by a NetworkPolicy',
    'From frontend to cart, GET /cart, allowed by an Istio AuthorizationPolicy',
    'From cart to api, POST /pay, allowed by an Istio AuthorizationPolicy',
  ]) {
    await expect(page.getByLabel(edge, { exact: true })).toBeVisible();
  }
});

test('choosing a workload shows what may call it', async ({ page }) => {
  await page.goto('/map/atlas-b');
  await page.getByRole('link', { name: /^cart\b/ }).click();

  await expect(page.getByRole('heading', { name: 'Selected by 2 policies' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'May call it' }).getByRole('listitem')).toHaveText(['shop / frontendTCP 8080', 'shop / frontendGET /cart']);
});

test('at 1440 by 900 the whole policy map fits its box, and Zoom In enlarges it', async ({ page }) => {
  await expectMapFitsAndZooms(page, '/map/atlas-b');
});

/** Every text a policy edge's label shows on atlas-b: the port a NetworkPolicy opens (`TCP 8080`), or the method and path an AuthorizationPolicy allows (`GET /cart`). */
const POLICY_LABEL = /^((TCP|UDP|SCTP) \d+|[A-Z]+ \/\S+)$/;

test('at 1440 by 900 no edge label lies on a workload box', async ({ page }) => {
  await page.setViewportSize(WIDE);
  await page.goto('/map/atlas-b');

  expect((await edgeLabelsOn(page, POLICY_LABEL)).boxes).toStrictEqual([]);
});

test('at 1440 by 900 no edge label lies on a namespace title', async ({ page }) => {
  await page.setViewportSize(WIDE);
  await page.goto('/map/atlas-b');

  expect((await edgeLabelsOn(page, POLICY_LABEL)).titles).toStrictEqual([]);
});

test('at 1440 by 900 no edge line is drawn over a namespace title', async ({ page }) => {
  await expectMapFits(page, '/map/atlas-b');

  expect(await titlesUnderLines(page)).toStrictEqual([]);
});

test('on a 375 pixel screen the policy map page scrolls no wider than the screen, and its map is scaled down to fit', async ({ page }) => {
  await expectFitsPhone(page, '/map/atlas-b');
});

test('the policy map has a name for assistive technology', async ({ page }) => {
  await page.goto('/map/atlas-b');

  await expect(page.getByRole('application', { name: 'Policy map of atlas-b', exact: true })).toBeVisible();
});

test('choosing another workload moves the focus to its panel', async ({ page }) => {
  await page.goto('/map/atlas-b');
  await page.getByRole('link', { name: /^cart\b/ }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'cart', exact: true })).toBeFocused();

  // The panel stays on the page from one workload to the next, so only a new heading for frontend takes the focus.
  await page.getByRole('link', { name: /^frontend\b/ }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'frontend', exact: true })).toBeFocused();
});

// atlas-a has no traffic source, so with every namespace hidden (an empty ns, as the Namespaces picker writes it)
// its map draws nothing at all, not even the Internet.
test('a map with every namespace hidden says how to show one', async ({ page }) => {
  await page.goto('/map/atlas-a?ns=');

  await expect(page.getByText('No namespace is shown. Open Namespaces to show one.', { exact: true })).toBeVisible();
});
