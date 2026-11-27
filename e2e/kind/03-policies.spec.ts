import { expect, test } from '@playwright/test';

test('the policy list groups the policies by cluster', async ({ page }) => {
  await page.goto('/policies');

  await expect(page.getByRole('heading', { level: 2 })).toHaveText(['atlas-a', 'atlas-b']);
  await expect(page.getByRole('region', { name: 'atlas-a' }).getByRole('row', { name: /^cart-allow / }).getByRole('cell')).toHaveText(['cart-allow', 'shop', 'NetworkPolicy', 'covers 1 workload']);
});

test('an Istio policy is shown, not edited', async ({ page }) => {
  await page.goto('/policies');
  await page.getByRole('region', { name: 'atlas-b' }).getByRole('link', { name: 'cart-callers', exact: true }).click();

  await expect(page).toHaveURL(/\/policies\/atlas-b\/shop\/authorizationpolicies\/cart-callers$/);
  await expect(page.getByText('Istio AuthorizationPolicy · namespace shop', { exact: true })).toBeVisible();
  await expect(page.getByText('Shown, not edited here.', { exact: true })).toBeVisible();
});
