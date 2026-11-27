import { expect, test } from '@playwright/test';

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
