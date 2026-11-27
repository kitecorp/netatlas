import { describe, expect, it } from 'vitest';
import { networkPolicy, SHOP, withPolicies } from './fixtures/shop';
import { evaluateNetworkPolicies, type AnyPeerRule } from './netpol';
import { formatPorts } from './ports';
import type { ClusterResources, NetworkPolicyObject, NetworkPolicySpec, PolicyRef } from './types';

const gateway = 'ingress/Deployment/gateway';
const frontend = 'shop/Deployment/frontend';
const cart = 'shop/Deployment/cart';
const recommender = 'shop/Deployment/recommender';
const api = 'payments/Deployment/api';
const postgres = 'payments/Deployment/postgres';
const coredns = 'kube-system/Deployment/coredns';

const ref = (namespace: string, name: string): PolicyRef => ({ kind: 'NetworkPolicy', namespace, name });

const policy = (name: string): NetworkPolicyObject => {
  const p = SHOP.networkPolicies.find((x) => x.metadata.name === name);
  if (!p) throw new Error(`SHOP has no NetworkPolicy ${name}`);
  return p;
};

/** SHOP's policy `name` with its spec changed by `change`. */
const changed = (name: string, change: (spec: NetworkPolicySpec) => NetworkPolicySpec): NetworkPolicyObject => {
  const p = policy(name);
  return { ...p, spec: change(p.spec) };
};

const rows = (r: ClusterResources) =>
  evaluateNetworkPolicies(r).edges.map((e) => [e.from, e.to, formatPorts(e.ports), e.peer ?? '', e.via.map((v) => v.name).join(',')]);

it('allows exactly the calls both sides allow in the shop cluster', () => expect(evaluateNetworkPolicies(SHOP).edges.map((e) => [e.from, e.to, formatPorts(e.ports), e.peer ?? '', e.via.map((v) => v.name).join(',')])).toEqual([
  [gateway, coredns, 'UDP 53, TCP 53', '', 'gateway-allow'], [gateway, frontend, 'TCP 8080', '', 'frontend-allow,gateway-allow'],
  ['outside', gateway, 'TCP 443', '0.0.0.0/0', 'gateway-allow'], [api, coredns, 'UDP 53, TCP 53', '', 'api-allow'],
  [api, postgres, 'TCP 5432', '', 'api-allow,postgres-allow'], [cart, coredns, 'UDP 53, TCP 53', '', 'cart-allow'],
  [cart, api, 'TCP 8443', '', 'api-allow,cart-allow'], [frontend, coredns, 'UDP 53, TCP 53', '', 'frontend-allow'],
  [frontend, cart, 'TCP 8080', '', 'cart-allow,frontend-allow'], [recommender, postgres, 'TCP 5432', '', 'postgres-allow'],
]));

it('covers only the sides a policy restricts, and no side of a pod no policy selects', () => {
  const { covered } = evaluateNetworkPolicies(SHOP);
  expect([covered.has(recommender), covered.has(coredns), covered.get(postgres)]).toEqual([
    false,
    false,
    { ingress: [ref('payments', 'postgres-allow')], egress: [] },
  ]);
});

describe('without policyTypes', () => {
  const untyped = ({ policyTypes: _types, ...spec }: NetworkPolicySpec): NetworkPolicySpec => spec;
  it.each<[string, string, string, { ingress: PolicyRef[]; egress: PolicyRef[] }]>([
    ['a policy with egress rules covers both sides', 'cart-allow', cart, { ingress: [ref('shop', 'cart-allow')], egress: [ref('shop', 'cart-allow')] }],
    ['a policy with no egress rules covers calls in only', 'postgres-allow', postgres, { ingress: [ref('payments', 'postgres-allow')], egress: [] }],
  ])('policyTypes default %#: %s', (_name, name, workload, expected) => {
    expect(evaluateNetworkPolicies(withPolicies(SHOP, changed(name, untyped))).covered.get(workload)).toEqual(expected);
  });
  it.each<[string, (spec: NetworkPolicySpec) => NetworkPolicySpec, { ingress: PolicyRef[]; egress: PolicyRef[] }]>([
    ['an empty policyTypes defaults as an absent one does', (spec) => ({ ...spec, policyTypes: [] }), { ingress: [ref('shop', 'cart-allow')], egress: [ref('shop', 'cart-allow')] }],
    ['an empty egress list is no egress rule, so calls out stay open', (spec) => ({ ...untyped(spec), egress: [] }), { ingress: [ref('shop', 'cart-allow')], egress: [] }],
  ])('policyTypes default by length %#: %s', (_name, change, expected) => {
    expect(evaluateNetworkPolicies(withPolicies(SHOP, changed('cart-allow', change))).covered.get(cart)).toEqual(expected);
  });
});

it('needs both sides: api-allow also admitting frontend adds no frontend-to-api edge', () => {
  const admitsFrontend = changed('api-allow', (spec) => ({
    ...spec,
    ingress: [...(spec.ingress ?? []), { from: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'shop' } }, podSelector: { matchLabels: { app: 'frontend' } } }], ports: [{ port: 8443 }] }],
  }));
  expect(rows(withPolicies(SHOP, admitsFrontend)).filter(([from, to]) => from === frontend && to === api)).toEqual([]);
});

it('leaves nothing into cart when its only Ingress policy has no rules', () => {
  const noRules = networkPolicy('shop', 'cart-allow', { podSelector: { matchLabels: { app: 'cart' } }, policyTypes: ['Ingress'] });
  expect(rows(withPolicies(SHOP, noRules)).filter(([, to]) => to === cart)).toEqual([]);
});

describe('the rules of every policy selecting a pod add up', () => {
  it.each<[string, NetworkPolicyObject, string, string[][]]>([
    [
      'an Ingress policy with no rules beside cart-allow takes nothing away',
      networkPolicy('shop', 'cart-deny-in', { podSelector: { matchLabels: { app: 'cart' } }, policyTypes: ['Ingress'] }),
      cart,
      [[frontend, cart, 'TCP 8080', '', 'cart-allow,frontend-allow']],
    ],
    [
      'a second policy admitting recommender to postgres adds its port',
      networkPolicy('payments', 'postgres-metrics', {
        podSelector: { matchLabels: { app: 'postgres' } },
        policyTypes: ['Ingress'],
        ingress: [{ from: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'shop' } }, podSelector: { matchLabels: { app: 'recommender' } } }], ports: [{ port: 9187 }] }],
      }),
      postgres,
      [[api, postgres, 'TCP 5432', '', 'api-allow,postgres-allow'], [recommender, postgres, 'TCP 5432, TCP 9187', '', 'postgres-allow,postgres-metrics']],
    ],
  ])('union %#: %s', (_name, p, into, expected) => {
    expect(rows(withPolicies(SHOP, p)).filter(([, to]) => to === into)).toEqual(expected);
  });
});

it('selects peers by namespace too: a gateway copy in shop is not let into frontend', () => {
  const copy = SHOP.pods
    .filter((p) => p.workload.name === 'gateway')
    .map((p) => ({ ...p, namespace: 'shop', name: `shop-${p.name}`, mesh: 'sidecar' as const }));
  expect(rows({ ...SHOP, pods: [...SHOP.pods, ...copy] }).filter(([from]) => from === 'shop/Deployment/gateway')).toEqual([]);
});

describe('a rule with no peers', () => {
  it.each<[string, (spec: NetworkPolicySpec) => NetworkPolicySpec, AnyPeerRule[], string]>([
    [
      'from left out',
      (spec) => ({ ...spec, ingress: [{ ports: [{ port: 8080 }] }] }),
      [{ workload: cart, side: 'ingress', ports: [{ protocol: 'TCP', from: 8080, to: 8080 }], via: [ref('shop', 'cart-allow')] }],
      'TCP 8080',
    ],
    [
      'from an empty list',
      (spec) => ({ ...spec, ingress: [{ from: [], ports: [{ port: 8080 }] }] }),
      [{ workload: cart, side: 'ingress', ports: [{ protocol: 'TCP', from: 8080, to: 8080 }], via: [ref('shop', 'cart-allow')] }],
      'TCP 8080',
    ],
    [
      'to left out, on a named port, keeps the name',
      (spec) => ({ ...spec, egress: [{ ports: [{ protocol: 'UDP', port: 'dns' }] }] }),
      [{ workload: cart, side: 'egress', ports: [{ protocol: 'UDP', name: 'dns' }], via: [ref('shop', 'cart-allow')] }],
      'UDP port named dns',
    ],
  ])('any peer %#: %s', (_name, change, expected, text) => {
    const marks = evaluateNetworkPolicies(withPolicies(SHOP, changed('cart-allow', change))).anyPeer;
    expect([marks, marks.map((m) => formatPorts(m.ports))]).toEqual([expected, [text]]);
  });
});

describe('ipBlock peers', () => {
  it.each<[string, NetworkPolicyObject, string[][]]>([
    [
      'calls in from outside name the block and its exceptions',
      changed('gateway-allow', (spec) => ({ ...spec, ingress: [{ from: [{ ipBlock: { cidr: '0.0.0.0/0', except: ['10.0.0.0/8', '192.168.0.0/16'] } }], ports: [{ port: 443 }] }] })),
      [['outside', gateway, 'TCP 443', '0.0.0.0/0 except 10.0.0.0/8, 192.168.0.0/16', 'gateway-allow']],
    ],
    [
      'calls out to outside name the block',
      changed('api-allow', (spec) => ({ ...spec, egress: [...(spec.egress ?? []), { to: [{ ipBlock: { cidr: '203.0.113.0/24' } }], ports: [{ port: 443 }] }] })),
      [['outside', gateway, 'TCP 443', '0.0.0.0/0', 'gateway-allow'], [api, 'outside', 'TCP 443', '203.0.113.0/24', 'api-allow']],
    ],
    // A port name resolves only on a pod, so no port of an address outside the cluster has one.
    [
      'calls out to outside on a named port allow nothing, so they draw no edge',
      changed('api-allow', (spec) => ({ ...spec, egress: [...(spec.egress ?? []), { to: [{ ipBlock: { cidr: '0.0.0.0/0' } }], ports: [{ protocol: 'TCP', port: 'https' }] }] })),
      [['outside', gateway, 'TCP 443', '0.0.0.0/0', 'gateway-allow']],
    ],
    [
      'calls in from outside on a port name the pod does not have allow nothing, so they draw no edge',
      changed('gateway-allow', (spec) => ({ ...spec, ingress: [{ from: [{ ipBlock: { cidr: '0.0.0.0/0' } }], ports: [{ protocol: 'TCP', port: 'metrics' }] }] })),
      [],
    ],
  ])('ipBlock %#: %s', (_name, p, expected) => {
    expect(rows(withPolicies(SHOP, p)).filter(([from, to]) => from === 'outside' || to === 'outside')).toEqual(expected);
  });
});
