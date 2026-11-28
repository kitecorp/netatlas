import { expect, test } from '@playwright/test';
import { applyObject, kubectl } from './kube';

// Runs in its own namespace of atlas-b, which it deletes at the end, so the journeys after it count
// the clusters as the shop alone leaves them.
const ATLAS_B = 'kind-atlas-b';
const NAMESPACE = 'mesh-egress';

/** Lets every pod of the namespace call kube-dns and nothing else, which leaves out istiod. */
const PROBE_EGRESS = {
  apiVersion: 'networking.k8s.io/v1',
  kind: 'NetworkPolicy',
  metadata: { name: 'probe-egress', namespace: NAMESPACE },
  spec: {
    podSelector: {},
    policyTypes: ['Egress'],
    egress: [
      {
        to: [{ namespaceSelector: {}, podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } } }],
        ports: [
          { protocol: 'UDP', port: 53 },
          { protocol: 'TCP', port: 53 },
        ],
      },
    ],
  },
};

const deleteNamespace = () => kubectl(ATLAS_B, 'delete', 'namespace', NAMESPACE, '--ignore-not-found', '--wait=true', '--timeout=120s');

test.beforeAll(() => {
  // The namespace may first have to go (a run stopped before its afterAll), and the sidecar may be pulled.
  test.setTimeout(330_000);
  deleteNamespace();
  kubectl(ATLAS_B, 'create', 'namespace', NAMESPACE);
  kubectl(ATLAS_B, 'label', 'namespace', NAMESPACE, 'istio-injection=enabled');
  kubectl(ATLAS_B, '--namespace', NAMESPACE, 'create', 'deployment', 'probe', '--image=registry.k8s.io/pause:3.10', '--replicas=1');
  // A sidecar that starts under the policy never gets its first configuration from istiod, so the
  // policy comes only once the pod is ready, which its sidecar is only once configured.
  kubectl(ATLAS_B, '--namespace', NAMESPACE, 'rollout', 'status', 'deployment/probe', '--timeout=180s');
  applyObject(ATLAS_B, PROBE_EGRESS);
});

test.afterAll(() => {
  test.setTimeout(150_000);
  deleteNamespace();
});

test('a namespace whose egress policy leaves out istiod appears under "Needs attention"', async ({ page }) => {
  await page.goto('/');

  // atlas-b's shop lists its own workloads here too, so the probe's line is picked out.
  await expect(page.getByRole('region', { name: 'Egress the mesh needs' }).getByRole('listitem').filter({ hasText: 'mesh-egress / probe' })).toHaveText(
    'atlas-b: mesh-egress / probe cannot reach istiod on TCP 15012 (probe-egress). New pods do not become ready while these policies apply: their sidecar waits for configuration from istiod.',
    { timeout: 60_000 },
  );
});
