import { expect, test } from '@playwright/test';
import { linesOf } from './lines';
import { WIDE } from './map';

// Each cluster runs the 6 shop workloads plus kind's own (coredns, kube-proxy, kindnet,
// local-path-provisioner and the 4 control-plane pods), and netatlas in atlas-a or istiod in atlas-b:
// 15 workloads, of which only the 5 the shop's NetworkPolicies select have a policy. atlas-b also runs
// the traffic namespace's client and server and Istio's sample Prometheus, 18 workloads, and has the
// NetworkPolicy server-allow and the 2 AuthorizationPolicies: 8 policies, with 12 workloads that no
// policy selects. kind's own enforcer is not one netatlas names.
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
    '18',
    '8',
    '12',
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
    'atlas-b has 6 NetworkPolicies, but no enforcer was found, so they may do nothing.',
  ]);
});

test('at 1440 by 900 every cluster name in the table is on one line', async ({ page }) => {
  await page.setViewportSize(WIDE);
  await page.goto('/');
  // The other cells' texts share the table's width with the names, so the lines are counted once both rows hold their data.
  for (const cluster of [/^atlas-a/, /^atlas-b/]) {
    await expect(page.getByRole('row', { name: cluster }).getByRole('cell').last()).toHaveText(UPDATED, { timeout: 30_000 });
  }

  // A cluster's name is the one link in its row.
  expect(await linesOf(page.getByRole('region', { name: 'Clusters' }).getByRole('link'))).toStrictEqual([
    ['atlas-a', 1],
    ['atlas-b', 1],
  ]);
});
