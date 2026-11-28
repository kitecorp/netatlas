import { join } from 'node:path';
import { kubectl } from './kube';

const ATLAS_A = 'kind-atlas-a';
const ATLAS_B = 'kind-atlas-b';

// Playwright loads this file as CommonJS, so __dirname is this folder.
const SHOP_POLICIES = join(__dirname, '../manifests/network-policies.yaml');

/** The namespaces journeys 07 and 08 make in atlas-b for the length of their rows. */
const JOURNEY_NAMESPACES = ['outbound-block', 'mesh-egress'];

/**
 * Puts back, before the first journey, what a run stopped inside a journey leaves behind, so that a rerun
 * starts from the clusters as scripts/e2e/up.sh leaves them: the namespaces journeys 07 and 08 make in
 * atlas-b, which journey 01 would count, journey 05's change to cart-allow in atlas-a, and journey 09's
 * Prometheus at zero replicas. Each journey puts back its own when it ends; a run killed inside one cannot.
 * Each step is a no-op on clusters that are already as up.sh leaves them.
 */
export default function globalSetup(): void {
  try {
    kubectl(ATLAS_B, 'get', '--raw', '/readyz', '--request-timeout=10s');
  } catch {
    // Journey 99 stops atlas-b's node last, and only up.sh starts it again and puts its pods' policies back in order.
    throw new Error('atlas-b does not answer: start it again with bash scripts/e2e/up.sh');
  }
  for (const ns of JOURNEY_NAMESPACES) kubectl(ATLAS_B, 'delete', 'namespace', ns, '--ignore-not-found', '--wait=true', '--timeout=120s');
  // As up.sh restores it: the changed policy goes, and the shop's policies are applied again with up.sh's field
  // manager. atlas-a has no sidecars, so a policy applied again cannot keep one from istiod.
  kubectl(ATLAS_A, '--namespace', 'shop', 'delete', 'networkpolicy', 'cart-allow', '--ignore-not-found');
  kubectl(ATLAS_A, 'apply', '--server-side', '--force-conflicts', '--field-manager', 'netatlas-e2e', '-f', SHOP_POLICIES);
  kubectl(ATLAS_B, '--namespace', 'istio-system', 'scale', 'deployment/prometheus', '--replicas=1');
  kubectl(ATLAS_B, '--namespace', 'istio-system', 'rollout', 'status', 'deployment/prometheus', '--timeout=120s');
}
