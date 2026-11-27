import { expect, it } from 'vitest';
import type { AuthorizationPolicyObject, NetworkPolicyObject } from '@/model/types';
import { CART_ALLOW } from './fixtures';
import { forDisplay, toYaml } from './yaml';

it("shows cart-allow as the prototype's YAML, with its label and without what the server keeps for itself", () => {
  expect(toYaml(forDisplay(CART_ALLOW))).toBe(
    [
      'apiVersion: networking.k8s.io/v1',
      'kind: NetworkPolicy',
      'metadata:',
      '  name: cart-allow',
      '  namespace: shop',
      '  labels:',
      '    team: checkout',
      'spec:',
      '  podSelector:',
      '    matchLabels:',
      '      app: cart',
      '  policyTypes:',
      '    - Ingress',
      '    - Egress',
      '  ingress:',
      '    - from:',
      '        - podSelector:',
      '            matchLabels:',
      '              app: frontend',
      '      ports:',
      '        - port: 8080',
      '          protocol: TCP',
      '  egress:',
      '    - to:',
      '        - namespaceSelector:',
      '            matchLabels:',
      '              kubernetes.io/metadata.name: payments',
      '          podSelector:',
      '            matchLabels:',
      '              app: api',
      '      ports:',
      '        - port: 8443',
      '          protocol: TCP',
      '    - to:',
      '        - namespaceSelector:',
      '            matchLabels:',
      '              kubernetes.io/metadata.name: kube-system',
      '          podSelector:',
      '            matchLabels:',
      '              k8s-app: kube-dns',
      '      ports:',
      '        - port: 53',
      '          protocol: UDP',
      '        - port: 53',
      '          protocol: TCP',
      '',
    ].join('\n'),
  );
});

it('quotes every string YAML 1.1 would read as another type', () => {
  expect(toYaml({ a: 'true', b: '08', c: '1e3', d: 'null', e: 'yes', f: '', g: 'on' })).toBe('a: "true"\nb: "08"\nc: "1e3"\nd: "null"\ne: "yes"\nf: ""\ng: "on"\n');
});

it('keeps label values such as yes, on and 0123 as strings', () => {
  const p: NetworkPolicyObject = { ...CART_ALLOW, spec: { podSelector: { matchLabels: { enabled: 'yes', canary: 'on', build: '0123' } }, policyTypes: ['Ingress'] } };
  expect(toYaml((forDisplay(p) as { spec: unknown }).spec)).toBe('podSelector:\n  matchLabels:\n    enabled: "yes"\n    canary: "on"\n    build: "0123"\npolicyTypes:\n  - Ingress\n');
});

it('drops only the fields its list names, and puts the keys it knows first, in the order Kubernetes writes them', () => {
  const p = {
    status: { conditions: [] },
    spec: {
      'x-future': { mode: 'strict' },
      egress: [{ ports: [{ protocol: 'TCP', endPort: 32767, port: 30000, 'x-port': 1 }], to: [{ ipBlock: { cidr: '10.0.0.0/8' }, podSelector: {}, namespaceSelector: {} }], 'x-rule': 1 }],
      ingress: [{ ports: [{ protocol: 'UDP', port: 53 }], from: [{ podSelector: { matchLabels: { app: 'web' } } }] }],
      policyTypes: ['Ingress', 'Egress'],
      podSelector: {},
    },
    metadata: {
      finalizers: ['example.com/keep'],
      annotations: { 'kubectl.kubernetes.io/last-applied-configuration': '{}', 'example.com/owner': 'shop' },
      labels: { team: 'checkout' },
      managedFields: [],
      creationTimestamp: '2026-11-02T09:14:05Z',
      generation: 3,
      resourceVersion: '48213',
      uid: '3f1c8a52',
      namespace: 'shop',
      name: 'cart-allow',
    },
    kind: 'NetworkPolicy',
    apiVersion: 'networking.k8s.io/v1',
  } as unknown as NetworkPolicyObject;
  expect(toYaml(forDisplay(p))).toBe(
    [
      'apiVersion: networking.k8s.io/v1',
      'kind: NetworkPolicy',
      'metadata:',
      '  name: cart-allow',
      '  namespace: shop',
      '  labels:',
      '    team: checkout',
      '  annotations:',
      '    example.com/owner: shop',
      '  finalizers:',
      '    - example.com/keep',
      'spec:',
      '  podSelector: {}',
      '  policyTypes:',
      '    - Ingress',
      '    - Egress',
      '  ingress:',
      '    - from:',
      '        - podSelector:',
      '            matchLabels:',
      '              app: web',
      '      ports:',
      '        - port: 53',
      '          protocol: UDP',
      '  egress:',
      '    - to:',
      '        - namespaceSelector: {}',
      '          podSelector: {}',
      '          ipBlock:',
      '            cidr: 10.0.0.0/8',
      '      ports:',
      '        - port: 30000',
      '          endPort: 32767',
      '          protocol: TCP',
      '          x-port: 1',
      '      x-rule: 1',
      '  x-future:',
      '    mode: strict',
      'status:',
      '  conditions: []',
      '',
    ].join('\n'),
  );
});

it('drops annotations when only the last-applied one was there', () => {
  expect(Object.keys((forDisplay(CART_ALLOW) as { metadata: object }).metadata)).toStrictEqual(['name', 'namespace', 'labels']);
});

it("shows an Istio AuthorizationPolicy without what the server keeps for itself, its spec as written", () => {
  const callers: AuthorizationPolicyObject = {
    apiVersion: 'security.istio.io/v1',
    kind: 'AuthorizationPolicy',
    metadata: { name: 'cart-callers', namespace: 'shop', uid: 'b1', resourceVersion: '7', generation: 1 },
    spec: { selector: { matchLabels: { app: 'cart' } }, action: 'ALLOW', rules: [{ from: [{ source: { principals: ['cluster.local/ns/shop/sa/frontend'] } }] }] },
  };
  expect(toYaml(forDisplay(callers))).toBe(
    [
      'apiVersion: security.istio.io/v1',
      'kind: AuthorizationPolicy',
      'metadata:',
      '  name: cart-callers',
      '  namespace: shop',
      'spec:',
      '  selector:',
      '    matchLabels:',
      '      app: cart',
      '  action: ALLOW',
      '  rules:',
      '    - from:',
      '        - source:',
      '            principals:',
      '              - cluster.local/ns/shop/sa/frontend',
      '',
    ].join('\n'),
  );
});
