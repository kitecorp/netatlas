import { expect, test } from '@playwright/test';
import { allowPodsIn, CART_ALLOW, changesLine } from './editor';

// What Copy YAML copies after the recommender rule is added: cart-allow as the cluster has it, without
// the fields the server keeps for itself, and the new rule after the frontend one.
const YAML = `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: cart-allow
  namespace: shop
spec:
  podSelector:
    matchLabels:
      app: cart
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: frontend
      ports:
        - port: 8080
          protocol: TCP
    - from:
        - podSelector:
            matchLabels:
              app: recommender
      ports:
        - port: 8080
          protocol: TCP
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: payments
          podSelector:
            matchLabels:
              app: api
      ports:
        - port: 8443
          protocol: TCP
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
          podSelector:
            matchLabels:
              k8s-app: kube-dns
      ports:
        - port: 53
          protocol: UDP
        - port: 53
          protocol: TCP
`;

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

test('the editor drafts a change, shows it as lines, and copies it as YAML', async ({ page }) => {
  await page.goto(CART_ALLOW);
  await expect(changesLine(page)).toHaveText('No changes. This is what the cluster has now.');

  const callsIn = page.getByRole('button', { name: /^Calls in are/ });
  await callsIn.click();
  await expect(changesLine(page)).toHaveText('9 lines changed, not saved');

  await callsIn.click();
  await allowPodsIn(page, 'app=recommender', '8080');
  await expect(changesLine(page)).toHaveText('7 lines changed, not saved');

  await page.getByRole('button', { name: 'Review and save' }).click();
  await page.getByRole('button', { name: 'Copy YAML' }).click();
  await expect(page.getByText("Copied. Paste it over the policy's file in git.", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(YAML);
});
