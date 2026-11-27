// The editor's example policy, cart-allow, as the API server returns it: with the fields the server
// keeps for itself (uid, resourceVersion, managedFields, the last-applied annotation), which Copy YAML
// leaves out, and a label, which it keeps.
import type { NetworkPolicyObject, PolicyRule } from '@/model/types';

const kubeDns: PolicyRule = {
  to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } }, podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } } }],
  ports: [
    { port: 53, protocol: 'UDP' },
    { port: 53, protocol: 'TCP' },
  ],
};

export const CART_ALLOW: NetworkPolicyObject = {
  apiVersion: 'networking.k8s.io/v1',
  kind: 'NetworkPolicy',
  metadata: {
    name: 'cart-allow',
    namespace: 'shop',
    uid: '3f1c8a52-6d0e-4b7a-9c21-8e5f0d4b2a17',
    resourceVersion: '48213',
    generation: 3,
    creationTimestamp: '2026-11-02T09:14:05Z',
    labels: { team: 'checkout' },
    annotations: {
      'kubectl.kubernetes.io/last-applied-configuration':
        '{"apiVersion":"networking.k8s.io/v1","kind":"NetworkPolicy","metadata":{"name":"cart-allow","namespace":"shop"}}\n',
    },
    managedFields: [
      { manager: 'kubectl-client-side-apply', operation: 'Update', apiVersion: 'networking.k8s.io/v1', time: '2026-11-02T09:14:05Z', fieldsType: 'FieldsV1', fieldsV1: { 'f:spec': {} } },
    ],
  },
  spec: {
    podSelector: { matchLabels: { app: 'cart' } },
    policyTypes: ['Ingress', 'Egress'],
    ingress: [{ from: [{ podSelector: { matchLabels: { app: 'frontend' } } }], ports: [{ port: 8080, protocol: 'TCP' }] }],
    egress: [
      {
        to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'payments' } }, podSelector: { matchLabels: { app: 'api' } } }],
        ports: [{ port: 8443, protocol: 'TCP' }],
      },
      kubeDns,
    ],
  },
};

/** The kept ingress rule: a matchExpressions peer on the named port http. */
export const KEPT_IN: PolicyRule = {
  from: [{ podSelector: { matchExpressions: [{ key: 'app', operator: 'In', values: ['web', 'mobile'] }] } }],
  ports: [{ port: 'http', protocol: 'TCP' }],
};

/** The kept egress rule: an ipBlock with except, on a port range. */
export const KEPT_OUT: PolicyRule = {
  to: [{ ipBlock: { cidr: '10.0.0.0/8', except: ['10.1.0.0/16'] } }],
  ports: [{ port: 30000, endPort: 32767, protocol: 'TCP' }],
};

/** CART_ALLOW with a rule on each side the editor cannot draw, a rule with two peers (`in:2`) and a spec key netatlas does not know. */
export const CART_ALLOW_WITH_KEPT: NetworkPolicyObject = {
  ...CART_ALLOW,
  spec: {
    ...CART_ALLOW.spec,
    ingress: [
      ...(CART_ALLOW.spec.ingress ?? []),
      KEPT_IN,
      { from: [{ podSelector: { matchLabels: { app: 'frontend' } } }, { podSelector: { matchLabels: { app: 'web' } } }], ports: [{ port: 8080, protocol: 'TCP' }] },
    ],
    egress: [...(CART_ALLOW.spec.egress ?? []), KEPT_OUT],
    'x-future': { mode: 'strict' },
  },
};
