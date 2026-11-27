import { expect, test } from '@playwright/test';

// Each cluster runs the 6 shop workloads plus kind's own (coredns, kube-proxy, kindnet,
// local-path-provisioner and the 4 control-plane pods), and netatlas in atlas-a or istiod in atlas-b:
// 15 workloads, of which only the 5 the shop's NetworkPolicies select have a policy. atlas-b also
// has the 2 AuthorizationPolicies. kind's own enforcer is not one netatlas names.
const UPDATED = /^\d+ s ago$/;

test('the overview lists both clusters with their counts', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('row', { name: /^atlas-a/ }).getByRole('cell')).toHaveText(
    ['atlas-a', '1.37', '15', '5', '10', 'none found: policies may not be enforced', 'none', UPDATED],
    { timeout: 30_000 },
  );
  await expect(page.getByRole('row', { name: /^atlas-b/ }).getByRole('cell')).toHaveText([
    'atlas-b',
    '1.37',
    '15',
    '7',
    '10',
    'none found: policies may not be enforced',
    'sidecars',
    UPDATED,
  ]);
  await expect(page.getByRole('navigation', { name: 'Views' })).toContainText('Kubernetes API, 2 of 2');
});

test('the overview says where policies may do nothing', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('region', { name: 'Policies not enforced' }).getByRole('listitem')).toHaveText([
    'atlas-a has 5 NetworkPolicies, but no enforcer was found, so they may do nothing.',
    'atlas-b has 5 NetworkPolicies, but no enforcer was found, so they may do nothing.',
  ]);
});
