import { expect, type Page } from '@playwright/test';

/** cart-allow in atlas-a's shop, which the editor journeys open. */
export const CART_ALLOW = '/policies/atlas-a/shop/networkpolicies/cart-allow';

/** The line under the YAML pane's title that counts the changes. */
export const changesLine = (page: Page) => page.getByText(/^(No changes\. This is what the cluster has now\.|\d+ lines? changed, not saved)$/);

/** Adds a calls-in rule for the pods with these labels in the policy's own namespace, through Add rule and its form. */
export async function allowPodsIn(page: Page, labels: string, ports: string): Promise<void> {
  await page.getByRole('button', { name: 'Add rule: calls in from namespace shop' }).click();
  await page.getByRole('button', { name: /^Pods with labels/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Pods with labels' });
  await dialog.getByLabel('Pod labels').fill(labels);
  await dialog.getByLabel(/^Ports/).fill(ports);
  await dialog.getByRole('button', { name: 'Add rule' }).click();
  await expect(dialog).toHaveCount(0);
}
