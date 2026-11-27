import { describe, expect, it } from 'vitest';
import type { NetworkPolicyObject } from '@/model/types';
import { addRule, addRuleName, canSave, draftFromPolicy, groupsOf, invalidFields, isOpen, menuOptions, removeRow, specOf, toggleSide, type Draft, type Group, type RuleInput, type Side } from './draft';
import { CART_ALLOW, CART_ALLOW_WITH_KEPT } from './fixtures';

const rows = (d: Draft, s: 'in' | 'out') => groupsOf(d, s).map((g) => [g.title, g.rows.map((r) => [r.title, r.detail])]);

const KUBE_DNS_PEER = { namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } }, podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } } };

const EGRESS_ONLY: NetworkPolicyObject = {
  ...CART_ALLOW,
  spec: { podSelector: CART_ALLOW.spec.podSelector, policyTypes: ['Egress'], egress: CART_ALLOW.spec.egress ?? [] },
};

describe("gives back the cluster's spec when nothing was changed", () => {
  it.each<[string, (d: Draft) => Draft]>([
    ['as read', (d) => d],
    ['after the in lock is opened and closed again', (d) => toggleSide(toggleSide(d, 'in'), 'in')],
    ['after the out lock is opened and closed again', (d) => toggleSide(toggleSide(d, 'out'), 'out')],
  ])('unchanged %#: %s', (_name, change) => {
    expect(specOf(change(draftFromPolicy(CART_ALLOW_WITH_KEPT)))).toStrictEqual({
      podSelector: { matchLabels: { app: 'cart' } },
      policyTypes: ['Ingress', 'Egress'],
      ingress: [
        { from: [{ podSelector: { matchLabels: { app: 'frontend' } } }], ports: [{ port: 8080, protocol: 'TCP' }] },
        { from: [{ podSelector: { matchExpressions: [{ key: 'app', operator: 'In', values: ['web', 'mobile'] }] } }], ports: [{ port: 'http', protocol: 'TCP' }] },
        { from: [{ podSelector: { matchLabels: { app: 'frontend' } } }, { podSelector: { matchLabels: { app: 'web' } } }], ports: [{ port: 8080, protocol: 'TCP' }] },
      ],
      egress: [
        { to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'payments' } }, podSelector: { matchLabels: { app: 'api' } } }], ports: [{ port: 8443, protocol: 'TCP' }] },
        { to: [KUBE_DNS_PEER], ports: [{ port: 53, protocol: 'UDP' }, { port: 53, protocol: 'TCP' }] },
        { to: [{ ipBlock: { cidr: '10.0.0.0/8', except: ['10.1.0.0/16'] } }], ports: [{ port: 30000, endPort: 32767, protocol: 'TCP' }] },
      ],
      'x-future': { mode: 'strict' },
    });
  });
});

it("keeps a side nobody touched exactly as the base has it, even an open side's rules, when the other side changes", () => {
  const openInWithRules: NetworkPolicyObject = { ...CART_ALLOW, spec: { ...CART_ALLOW.spec, policyTypes: ['Egress'] } };
  const spec = specOf(removeRow(draftFromPolicy(openInWithRules), 'out', 'out:0:0'));
  expect([spec.policyTypes, spec.ingress]).toStrictEqual([['Egress'], [{ from: [{ podSelector: { matchLabels: { app: 'frontend' } } }], ports: [{ port: 8080, protocol: 'TCP' }] }]]);
});

it('draws the prototype rows for cart-allow', () => {
  const d = draftFromPolicy(CART_ALLOW);
  expect([rows(d, 'in'), rows(d, 'out')]).toStrictEqual([
    [['Outside the cluster', []], ['In namespace shop', [['Pods with app=frontend', 'TCP 8080']]], ['Across the cluster', []]],
    [['Outside the cluster', []], ['In namespace shop', []], ['Across the cluster', [['Pods with app=api in namespace payments', 'TCP 8443'], ['Kubernetes DNS', 'kube-dns in kube-system, UDP and TCP 53']]]],
  ]);
});

it('keeps each rule it cannot draw as one row on each side, shown as its YAML', () => {
  const d = draftFromPolicy(CART_ALLOW_WITH_KEPT);
  const kept = (s: 'in' | 'out') => groupsOf(d, s).flatMap((g) => g.rows.filter((r) => r.kept).map((r) => [g.group, r]));
  expect([kept('in'), kept('out')]).toStrictEqual([
    [
      [
        'namespace',
        {
          id: 'in:1',
          title: 'Kept as written',
          detail: 'from:\n  - podSelector:\n      matchExpressions:\n        - key: app\n          operator: In\n          values:\n            - web\n            - mobile\nports:\n  - port: http\n    protocol: TCP',
          kept: true,
        },
      ],
    ],
    [['outside', { id: 'out:2', title: 'Kept as written', detail: 'to:\n  - ipBlock:\n      cidr: 10.0.0.0/8\n      except:\n        - 10.1.0.0/16\nports:\n  - port: 30000\n    endPort: 32767\n    protocol: TCP', kept: true }]],
  ]);
});

it('gives each peer of a drawn rule its own row, with the ids the page removes them by', () => {
  expect(groupsOf(draftFromPolicy(CART_ALLOW_WITH_KEPT), 'in').flatMap((g) => g.rows.map((r) => [r.id, r.title]))).toStrictEqual([
    ['in:0:0', 'Pods with app=frontend'],
    ['in:1', 'Kept as written'],
    ['in:2:0', 'Pods with app=frontend'],
    ['in:2:1', 'Pods with app=web'],
  ]);
});

describe('removing', () => {
  it('removes the peer of a row and keeps the rest of its rule, and the kept rule, unchanged', () => {
    const spec = specOf(removeRow(draftFromPolicy(CART_ALLOW_WITH_KEPT), 'in', 'in:2:1'));
    expect(spec.ingress).toStrictEqual([
      { from: [{ podSelector: { matchLabels: { app: 'frontend' } } }], ports: [{ port: 8080, protocol: 'TCP' }] },
      { from: [{ podSelector: { matchExpressions: [{ key: 'app', operator: 'In', values: ['web', 'mobile'] }] } }], ports: [{ port: 'http', protocol: 'TCP' }] },
      { from: [{ podSelector: { matchLabels: { app: 'frontend' } } }], ports: [{ port: 8080, protocol: 'TCP' }] },
    ]);
  });

  it('drops a rule whose last peer is removed, so it never opens to every caller', () => {
    const spec = specOf(removeRow(draftFromPolicy(CART_ALLOW), 'in', 'in:0:0'));
    expect([spec.ingress, spec.policyTypes]).toStrictEqual([undefined, ['Ingress', 'Egress']]);
  });

  it.each<[string, string, unknown[]]>([
    ['a kept rule goes as a whole', 'out:2', [
      { to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'payments' } }, podSelector: { matchLabels: { app: 'api' } } }], ports: [{ port: 8443, protocol: 'TCP' }] },
      { to: [KUBE_DNS_PEER], ports: [{ port: 53, protocol: 'UDP' }, { port: 53, protocol: 'TCP' }] },
    ]],
    ['the rows of the other rules keep their ids', 'out:0:0', [
      { to: [KUBE_DNS_PEER], ports: [{ port: 53, protocol: 'UDP' }, { port: 53, protocol: 'TCP' }] },
      { to: [{ ipBlock: { cidr: '10.0.0.0/8', except: ['10.1.0.0/16'] } }], ports: [{ port: 30000, endPort: 32767, protocol: 'TCP' }] },
    ]],
  ])('remove %#: %s', (_name, id, expected) => {
    expect(specOf(removeRow(draftFromPolicy(CART_ALLOW_WITH_KEPT), 'out', id)).egress).toStrictEqual(expected);
  });

  it('removes a rule with no peers as a whole', () => {
    const anything: NetworkPolicyObject = { ...CART_ALLOW, spec: { ...CART_ALLOW.spec, ingress: [{ ports: [{ port: 8080, protocol: 'TCP' }] }] } };
    const d = draftFromPolicy(anything);
    expect([groupsOf(d, 'in').flatMap((g) => g.rows.map((r) => [g.group, r.id, r.title, r.detail])), specOf(removeRow(d, 'in', 'in:0')).ingress]).toStrictEqual([
      [['cluster', 'in:0', 'Anything, in this cluster or outside it', 'TCP 8080']],
      undefined,
    ]);
  });
});

describe('locks', () => {
  it('opening in drops ingress and its policy type, but the in-rows stay', () => {
    const d = toggleSide(draftFromPolicy(CART_ALLOW), 'in');
    const spec = specOf(d);
    expect([isOpen(d, 'in'), spec.policyTypes, 'ingress' in spec, rows(d, 'in')[1]]).toStrictEqual([true, ['Egress'], false, ['In namespace shop', [['Pods with app=frontend', 'TCP 8080']]]]);
  });

  it('restricting in on an egress-only policy appends Ingress', () => {
    const d = toggleSide(draftFromPolicy(EGRESS_ONLY), 'in');
    expect([isOpen(draftFromPolicy(EGRESS_ONLY), 'in'), specOf(d).policyTypes, specOf(d).ingress]).toStrictEqual([true, ['Egress', 'Ingress'], undefined]);
  });

  it.each<[string, (d: Draft) => Draft, ReturnType<typeof canSave>]>([
    ['both sides restricted', (d) => d, { ok: true }],
    ['one side open', (d) => toggleSide(d, 'out'), { ok: true }],
    ['both sides open', (d) => toggleSide(toggleSide(d, 'in'), 'out'), { ok: false, reason: 'both-open' }],
  ])('canSave %#: %s', (_name, change, expected) => {
    expect(canSave(change(draftFromPolicy(CART_ALLOW)))).toStrictEqual(expected);
  });
});

const input = (s: Partial<RuleInput> & Pick<RuleInput, 'group' | 'kind'>): RuleInput => ({ ports: '', ...s });

describe('addRule', () => {
  it.each<[string, 'in' | 'out', RuleInput, unknown]>([
    ['outside, any, 443', 'in', input({ group: 'outside', kind: 'any', ports: '443' }), { from: [{ ipBlock: { cidr: '0.0.0.0/0' } }], ports: [{ port: 443, protocol: 'TCP' }] }],
    ['a CIDR with no ports has no ports key', 'in', input({ group: 'outside', kind: 'cidr', cidr: ' 10.0.0.0/8 ' }), { from: [{ ipBlock: { cidr: '10.0.0.0/8' } }] }],
    ['namespace, any', 'in', input({ group: 'namespace', kind: 'any' }), { from: [{ podSelector: {} }] }],
    ['namespace, labels', 'in', input({ group: 'namespace', kind: 'labels', pod: 'app=web, version=2', ports: '8080' }), { from: [{ podSelector: { matchLabels: { app: 'web', version: '2' } } }], ports: [{ port: 8080, protocol: 'TCP' }] }],
    ['cluster, any', 'out', input({ group: 'cluster', kind: 'any' }), { to: [{ namespaceSelector: {} }] }],
    ['cluster with namespace labels only', 'out', input({ group: 'cluster', kind: 'labels', ns: 'kubernetes.io/metadata.name=payments', pod: '' }), { to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'payments' } } }] }],
    ['DNS out', 'out', input({ group: 'cluster', kind: 'dns' }), { to: [KUBE_DNS_PEER], ports: [{ port: 53, protocol: 'UDP' }, { port: 53, protocol: 'TCP' }] }],
  ])('addRule %#: %s', (_name, s, i, expected) => {
    const spec = specOf(addRule(draftFromPolicy(CART_ALLOW), s, i));
    expect((s === 'in' ? spec.ingress : spec.egress)?.at(-1)).toStrictEqual(expected);
  });

  it('ignores a rule with a field that does not parse', () => {
    const d = draftFromPolicy(CART_ALLOW);
    expect(specOf(addRule(d, 'in', input({ group: 'outside', kind: 'cidr', cidr: '10.0.0.0' })))).toStrictEqual(specOf(d));
  });

  it.each<[string, 'in' | 'out', RuleInput, [string, string, string]]>([
    ['any address', 'in', input({ group: 'outside', kind: 'any', ports: '443' }), ['in:1:0', 'Any address', '0.0.0.0/0, TCP 443']],
    ['an address range', 'in', input({ group: 'outside', kind: 'cidr', cidr: '10.0.0.0/8' }), ['in:1:0', '10.0.0.0/8', 'every port']],
    ['every pod in the namespace', 'in', input({ group: 'namespace', kind: 'any' }), ['in:1:0', 'Every pod in shop', 'every port']],
    ['pods with labels', 'in', input({ group: 'namespace', kind: 'labels', pod: 'app=frontend, version=2', ports: '8080, 53/UDP' }), ['in:1:0', 'Pods with app=frontend, version=2', 'TCP 8080, UDP 53']],
    ['every pod in every namespace', 'out', input({ group: 'cluster', kind: 'any' }), ['out:2:0', 'Every pod in every namespace', 'every port']],
    ['every pod in one namespace', 'out', input({ group: 'cluster', kind: 'labels', ns: 'kubernetes.io/metadata.name=payments' }), ['out:2:0', 'Every pod in namespace payments', 'every port']],
    ['pods in labelled namespaces', 'out', input({ group: 'cluster', kind: 'labels', ns: 'team=a', pod: 'app=x', ports: '80' }), ['out:2:0', 'Pods with app=x in namespaces with team=a', 'TCP 80']],
    ['Kubernetes DNS', 'out', input({ group: 'cluster', kind: 'dns' }), ['out:2:0', 'Kubernetes DNS', 'kube-dns in kube-system, UDP and TCP 53']],
  ])('the row of a new rule %#: %s', (_name, s, i, expected) => {
    const added = groupsOf(addRule(draftFromPolicy(CART_ALLOW), s, i), s).flatMap((g) => g.rows).find((r) => r.id === expected[0]);
    expect(added && [added.id, added.title, added.detail]).toStrictEqual(expected);
  });
});

it.each<[string, RuleInput, string[]]>([
  ['an empty pod field', input({ group: 'namespace', kind: 'labels', pod: '' }), ['pod']],
  ['an empty namespace field', input({ group: 'cluster', kind: 'labels', ns: '', pod: '' }), ['ns']],
  ['a CIDR without a prefix and an unknown protocol', input({ group: 'outside', kind: 'cidr', cidr: '10.0.0.0', ports: '80/HTTP' }), ['cidr', 'ports']],
  ['a valid rule', input({ group: 'cluster', kind: 'labels', ns: 'team=a', pod: 'app=x', ports: '80' }), []],
  ['DNS has its own ports', input({ group: 'cluster', kind: 'dns', ports: 'not used' }), []],
])('invalidFields %#: %s', (_name, i, expected) => {
  expect(invalidFields(i)).toStrictEqual(expected);
});

it.each<['in' | 'out', RuleInput['group'], string[]]>([
  ['in', 'outside', ['any: Any address', 'cidr: An address range']],
  ['in', 'namespace', ['any: Every pod in shop', 'labels: Pods with labels']],
  ['in', 'cluster', ['any: Every pod in every namespace', 'labels: Pods in chosen namespaces']],
  ['out', 'cluster', ['any: Every pod in every namespace', 'labels: Pods in chosen namespaces', 'dns: Kubernetes DNS']],
])('menuOptions(%s, %s)', (s, group, expected) => {
  expect(menuOptions(s, group, 'shop').map((o) => `${o.kind}: ${o.title}`)).toStrictEqual(expected);
});

it('gives the hints of the prototype', () => {
  expect(menuOptions('out', 'cluster', 'shop').map((o) => o.hint)).toStrictEqual([
    'On every port or the ones you choose',
    'By namespace labels, and pod labels if you want',
    'kube-dns in kube-system, port 53',
  ]);
});

// The name starts with the button's visible text, so "click Add rule" in voice control finds it.
it.each<[Side, Group, string]>([
  ['in', 'outside', 'Add rule: calls in from outside the cluster'],
  ['in', 'namespace', 'Add rule: calls in from namespace shop'],
  ['out', 'cluster', 'Add rule: calls out across the cluster'],
  ['out', 'namespace', 'Add rule: calls out to namespace shop'],
])('addRuleName %s %s', (side, group, expected) => {
  expect(addRuleName(side, group, 'shop')).toBe(expected);
});
