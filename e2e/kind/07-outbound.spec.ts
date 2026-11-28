import { expect, test } from '@playwright/test';
import { applyObject, kubectl } from './kube';
import { FIGURES_WAIT } from './traffic';

// atlas-b's client calls outside-http.example, the host of the ServiceEntry traffic/outside-http (HTTP
// 8080), and the outside TCP echo by its address, which Istio cannot name. No NetworkPolicy restricts
// client's egress and the mesh config sets no outbound mode, so both layers let it call any address and
// any domain. That ServiceEntry is the one destination the policies name: the shop's only address block
// is an ingress rule. A row lists client only once its calls are counted, so those checks wait for the
// figures. The verdict texts are the ones src/model/outbound-mode.ts prints for client. A row's destination is
// its row header, so its cells are Ports, May call and Do call, the last.

const ATLAS_B = 'kind-atlas-b';

// An egress NetworkPolicy that names an address block, for a workload of a namespace of its own: atlas-b has no
// such rule otherwise. The namespace has no sidecars, so the policy cannot keep a sidecar from istiod, and it is
// deleted again before the other rows of this file run, which count the destinations the shop alone names.
const BLOCK_NAMESPACE = 'outbound-block';
const BLOCK_EGRESS = {
  apiVersion: 'networking.k8s.io/v1',
  kind: 'NetworkPolicy',
  metadata: { name: 'block-egress', namespace: BLOCK_NAMESPACE },
  spec: { podSelector: {}, policyTypes: ['Egress'], egress: [{ to: [{ ipBlock: { cidr: '192.0.2.0/24' } }], ports: [{ protocol: 'TCP', port: 443 }] }] },
};

const deleteBlockNamespace = () => kubectl(ATLAS_B, 'delete', 'namespace', BLOCK_NAMESPACE, '--ignore-not-found', '--wait=true', '--timeout=120s');

test.describe('an address block an egress rule names', () => {
  test.beforeAll(() => {
    // The namespace may first have to go: a run stopped before its afterAll.
    test.setTimeout(330_000);
    deleteBlockNamespace();
    kubectl(ATLAS_B, 'create', 'namespace', BLOCK_NAMESPACE);
    kubectl(ATLAS_B, '--namespace', BLOCK_NAMESPACE, 'create', 'deployment', 'probe', '--image=registry.k8s.io/pause:3.10', '--replicas=1');
    kubectl(ATLAS_B, '--namespace', BLOCK_NAMESPACE, 'rollout', 'status', 'deployment/probe', '--timeout=180s');
    applyObject(ATLAS_B, BLOCK_EGRESS);
  });

  test.afterAll(() => {
    test.setTimeout(150_000);
    deleteBlockNamespace();
  });

  // Istio records no address, so a call to a block is never counted, and its Do call cell says nothing, as the
  // any row's does: `none` would say that nobody called it. The cell is read once the figures are on the page,
  // since before them every Do call cell is empty.
  test("the Outbound view leaves an address block's Do call cell empty", async ({ page }) => {
    await page.goto('/outbound/atlas-b');

    await expect(page.getByRole('row', { name: /^outside-http\.example/ }).getByRole('cell').last()).toHaveText(/^\s*traffic \/ client\s*\d+(\.\d)? req\/s\s*$/, {
      timeout: FIGURES_WAIT,
    });
    await expect(page.getByRole('row', { name: /^192\.0\.2\.0\/24/ }).getByRole('cell').last()).toHaveText('');
  });
});

test("the Outbound view lists the ServiceEntry host with its caller and the caller's verdicts", async ({ page }) => {
  await page.goto('/outbound/atlas-b');

  const cells = page.getByRole('row', { name: /^outside-http\.example/ }).getByRole('cell');
  await expect(cells.nth(0)).toHaveText('HTTP 8080');
  // Each verdict line follows its workload's line, so the verdicts are read as client's own.
  await expect(cells.nth(1)).toContainText(
    /traffic \/ client\s*NetworkPolicy: any address: no NetworkPolicy restricts its egress\s*Istio: any domain \(ALLOW_ANY, Istio's default\)/,
    { timeout: FIGURES_WAIT },
  );
  // client is the host's only caller. A regex is tested on the raw text, so the anchors allow whitespace.
  await expect(cells.last()).toHaveText(/^\s*traffic \/ client\s*\d+(\.\d)? req\/s\s*$/, { timeout: FIGURES_WAIT });
});

test('the Outbound view lists the TCP calls as unregistered TLS or TCP traffic', async ({ page }) => {
  await page.goto('/outbound/atlas-b');

  // A TCP call carries no requests, so its figure is its bytes.
  await expect(page.getByRole('row', { name: /^Unregistered TLS or TCP traffic/ }).getByRole('cell').last()).toHaveText(
    /^\s*traffic \/ client\s*(\d+(\.\d)? (B|kB)\/s|< 1 B\/s)\s*$/,
    { timeout: FIGURES_WAIT },
  );
});

// The policies alone decide who may call any address, so this check needs no figures. No NetworkPolicy
// restricts server's egress and the mesh config sets no outbound mode, so server is on that one row.
test('the Outbound view lists every workload that may call any address in one row', async ({ page }) => {
  await page.goto('/outbound/atlas-b');

  // A row's name starts with its destination.
  const anyOther = page.getByRole('row', { name: /^Any other address or domain/ });
  await expect(anyOther).toHaveCount(1);
  await expect(anyOther.getByRole('cell').nth(1)).toContainText('traffic / server');
});

// A screen reader names each cell's row by its destination as it moves across the row.
test('the Outbound table names each row by its destination', async ({ page }) => {
  await page.goto('/outbound/atlas-b');

  await expect(page.getByRole('row', { name: /^outside-http\.example/ }).getByRole('rowheader')).toHaveText('outside-http.example');
});

// The table is wider than a phone, so its box scrolls sideways; a box that takes the focus lets the keyboard scroll it.
test("the Outbound table's scroll box takes the focus and has a name", async ({ page }) => {
  await page.goto('/outbound/atlas-b');
  const box = page.getByRole('region', { name: 'Destinations of atlas-b', exact: true });
  await expect(box).toBeVisible();

  await box.focus();
  await expect(box).toBeFocused();
});

test('the Outbound search keeps the destinations it matches, and says when none does', async ({ page }) => {
  await page.goto('/outbound/atlas-b');
  const search = page.getByRole('searchbox', { name: 'Search' });
  const table = page.getByRole('table', { name: 'Destinations of atlas-b' });

  await search.fill('outside-http');
  await expect(page).toHaveURL(/\/outbound\/atlas-b\?q=outside-http$/);
  // The header row and the one destination whose name holds the search: no workload's name holds it.
  await expect(table.getByRole('row')).toHaveCount(2);
  await expect(table.getByRole('row', { name: /^outside-http\.example/ })).toBeVisible();

  await search.fill('no-such-destination');
  await expect(page.getByText('No destination matches the search.', { exact: true })).toBeVisible();
});

test("the map's Internet node opens the short list", async ({ page }) => {
  await page.goto('/map/atlas-b');
  await page.getByRole('link', { name: /^Internet/ }).click();

  const panel = page.getByRole('region', { name: 'Outside the cluster', exact: true });
  const mostCalled = panel.getByRole('region', { name: 'Most called, last 5 minutes', exact: true }).getByRole('listitem');
  await expect(mostCalled.filter({ hasText: /^\s*outside-http\.example/ })).toHaveText(/^\s*outside-http\.example\s*\d+(\.\d)? req\/s\s*$/, { timeout: FIGURES_WAIT });
  await expect(panel).toContainText('1 destination named by the policies');
  await expect(panel.getByRole('link', { name: 'Open the Outbound view', exact: true })).toHaveAttribute('href', '/outbound/atlas-b');
});
