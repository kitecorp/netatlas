import { expect, test } from '@playwright/test';
import { allowPodsIn, CART_ALLOW, changesLine } from './editor';
import { createToken, kubectl } from './kube';
import { fillSecret, isEmpty } from './secret';

// Changes cart-allow in atlas-a; scripts/e2e/up.sh puts the shop's version back on a rerun.
const ingressApps = () => kubectl('kind-atlas-a', '--namespace', 'shop', 'get', 'networkpolicy', 'cart-allow', '-o', 'jsonpath={.spec.ingress[*].from[*].podSelector.matchLabels.app}');

const FORBIDDEN =
  'Kubernetes refused the change: networkpolicies.networking.k8s.io "cart-allow" is forbidden: User "system:serviceaccount:shop:policy-reader" cannot update resource "networkpolicies" in API group "networking.k8s.io" in the namespace "shop"';

// CI uploads the HTML report of a failed run, so nothing in it may hold a token. A trace records each
// action's values, so this journey keeps none. Playwright names a fill by its value and a failed locator
// wait carries an aria snapshot of the page, which shows a password field's value; so the tokens go in
// through fillSecret, and every wait while one may sit in the field polls a boolean. The page snapshot
// Playwright adds to a failure is off for this run (playwright.kind.config.ts).
test.use({ trace: 'off' });

/** Waits until `check` holds; a failure prints only `false`. */
const until = (check: () => Promise<boolean>) => expect.poll(check).toBe(true);

const PAGE = `http://127.0.0.1:3000${CART_ALLOW}`;
const APPLY = 'http://127.0.0.1:3000/api/clusters/atlas-a/namespaces/shop/networkpolicies/cart-allow';

// A token must reach nothing but the one request body. The checks below compare booleans and counts,
// never the text that would hold a token, so a failing check cannot print one either. They are soft, so
// one run reports every place a token reached.
test("Apply writes with the person's own token, so Kubernetes decides", async ({ page }) => {
  const logged: string[] = [];
  const puts: string[] = [];
  page.on('console', (m) => logged.push(m.text()));
  page.on('request', (r) => {
    if (r.method() === 'PUT') puts.push(r.url());
  });
  await page.goto(CART_ALLOW);
  await allowPodsIn(page, 'app=recommender', '8080');
  await page.getByRole('button', { name: 'Review and save' }).click();
  await page.getByRole('button', { name: 'Apply to cluster' }).click();
  const token = page.getByLabel('Your Kubernetes token');
  const applyWithToken = page.getByRole('button', { name: 'Apply with my token' });

  const reader = createToken('kind-atlas-a', 'shop', 'policy-reader');
  await fillSecret(token, reader);
  await applyWithToken.click();
  await until(() => page.getByText(FORBIDDEN, { exact: true }).isVisible());
  await until(() => isEmpty(token));
  expect(ingressApps()).toBe('frontend');

  const writer = createToken('kind-atlas-a', 'shop', 'policy-writer');
  await fillSecret(token, writer);
  await applyWithToken.click();
  await until(() => page.getByText('Applied. The cluster now has this version.', { exact: true }).isVisible());
  await until(async () => (await token.count()) === 0);
  await expect(changesLine(page)).toHaveText('No changes. This is what the cluster has now.');
  expect(ingressApps()).toBe('frontend recommender');

  const holds = (text: string) => text.includes(reader) || text.includes(writer);
  expect.soft(puts.map((url) => url === APPLY)).toStrictEqual([true, true]);
  expect.soft(page.url() === PAGE).toBe(true);
  expect.soft(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toStrictEqual([0, 0]);
  expect.soft(holds(await page.content())).toBe(false);
  expect.soft(logged.filter(holds).length).toBe(0);
  expect.soft(holds(kubectl('kind-atlas-a', '--namespace', 'netatlas', 'logs', 'deployment/netatlas'))).toBe(false);
});
