import { describe, expect, it } from 'vitest';
import { authorizationPolicy, MESH_DENY_ADMIN, SHOP, withPolicies } from './fixtures/shop';
import { evaluateAuthorizationPolicies, istioMatch, type IstioEdge } from './istio';
import type { AuthorizationPolicyObject, AuthorizationPolicySpec, ClusterResources, Mesh, PolicyRef } from './types';

const gateway = 'ingress/Deployment/gateway';
const frontend = 'shop/Deployment/frontend';
const cart = 'shop/Deployment/cart';
const recommender = 'shop/Deployment/recommender';
const api = 'payments/Deployment/api';
const postgres = 'payments/Deployment/postgres';
const coredns = 'kube-system/Deployment/coredns';

const ref = (namespace: string, name: string): PolicyRef => ({ kind: 'AuthorizationPolicy', namespace, name });
const onCart = { matchLabels: { app: 'cart' } };
const DEPENDS = 'depends on the request';
const PLAIN = 'accepted unless mutual TLS is STRICT';

const policy = (name: string): AuthorizationPolicyObject => {
  const p = SHOP.authorizationPolicies === 'not-installed' ? undefined : SHOP.authorizationPolicies.find((x) => x.metadata.name === name);
  if (!p) throw new Error(`SHOP has no AuthorizationPolicy ${name}`);
  return p;
};

/** SHOP's policy `name` with its spec changed by `change`. */
const changed = (name: string, change: (spec: AuthorizationPolicySpec) => AuthorizationPolicySpec): AuthorizationPolicyObject => {
  const p = policy(name);
  return { ...p, spec: change(p.spec) };
};

const withCartMesh = (mesh: Mesh): ClusterResources => ({ ...SHOP, pods: SHOP.pods.map((p) => (p.workload.name === 'cart' ? { ...p, mesh } : p)) });

/**
 * The policies an edge names: the ALLOW policies that let the call in, then, after `unless`, the CUSTOM and DENY
 * policies that may refuse some of its requests. Neither of those two allows anything, so neither is ever among
 * the first (istio/api security/v1beta1/authorization_policy.proto:28-33 at 97748e4).
 */
const policiesOf = (e: IstioEdge) =>
  [e.via.map((v) => v.name).join(','), ...(e.mayRefuse?.length ? [`unless ${e.mayRefuse.map((v) => v.name).join(',')}`] : [])].filter(Boolean).join(' ');

const rows = (r: ClusterResources) => evaluateAuthorizationPolicies(r).edges.map((e) => [e.from, e.to, e.label, policiesOf(e), e.depends ?? '', e.plainText ?? '']);

const SHOP_EDGES = [
  [cart, api, 'POST /pay', 'api-callers', '', ''],
  [frontend, cart, 'GET /cart', 'cart-callers', '', ''],
];

it('lets only the named principals call, labelled by operation', () => {
  expect(rows(SHOP)).toEqual(SHOP_EDGES);
});

describe('labels', () => {
  it.each<[string, AuthorizationPolicySpec['rules'], string[][]]>([
    [
      'each operation, with its port, joined by semicolons',
      [{ from: [{ source: { principals: ['cluster.local/ns/shop/sa/frontend'] } }], to: [{ operation: { methods: ['GET', 'POST'], paths: ['/cart', '/cart/*'], ports: ['8080'] } }, { operation: { methods: ['DELETE'] } }] }],
      [[frontend, cart, 'GET,POST /cart,/cart/* port 8080; DELETE', 'cart-callers', '', '']],
    ],
    ['a rule with no operations allows any request', [{ from: [{ source: { principals: ['cluster.local/ns/shop/sa/frontend'] } }] }], [[frontend, cart, 'any request', 'cart-callers', '', '']]],
  ])('label %#: %s', (_name, rules, expected) => {
    expect(rows(withPolicies(SHOP, changed('cart-callers', (spec) => ({ ...spec, rules })))).filter(([, to]) => to === cart)).toEqual(expected);
  });
});

describe('not- fields exclude what they name', () => {
  it.each<[string, AuthorizationPolicyObject, string[][]]>([
    [
      'a DENY of everyone but frontend leaves frontend in',
      authorizationPolicy('shop', 'cart-deny-others', { selector: onCart, action: 'DENY', rules: [{ from: [{ source: { notPrincipals: ['cluster.local/ns/shop/sa/frontend'] } }] }] }),
      [[frontend, cart, 'GET /cart', 'cart-callers', '', '']],
    ],
    [
      'an ALLOW of every namespace but payments lets the rest in, plain text too, which has no namespace',
      authorizationPolicy('shop', 'cart-callers', { selector: onCart, action: 'ALLOW', rules: [{ from: [{ source: { notNamespaces: ['payments'] } }] }] }),
      [
        [gateway, cart, 'any request', 'cart-callers', '', PLAIN],
        [coredns, cart, 'any request', 'cart-callers', '', PLAIN],
        [frontend, cart, 'any request', 'cart-callers', '', ''],
        [recommender, cart, 'any request', 'cart-callers', '', ''],
      ],
    ],
  ])('not %#: %s', (_name, p, expected) => {
    expect(rows(withPolicies(SHOP, p)).filter(([, to]) => to === cart)).toEqual(expected);
  });
});

describe('policies that leave no edge into cart', () => {
  it.each<[string, AuthorizationPolicyObject]>([
    ['an ALLOW policy with no rules denies everything', authorizationPolicy('shop', 'cart-callers', { selector: onCart, action: 'ALLOW' })],
    [
      'a DENY from shop wins over the ALLOW for frontend',
      authorizationPolicy('shop', 'cart-deny-shop', { selector: onCart, action: 'DENY', rules: [{ from: [{ source: { namespaces: ['shop'] } }] }] }),
    ],
  ])('no edge %#: %s', (_name, p) => {
    expect(rows(withPolicies(SHOP, p)).filter(([, to]) => to === cart)).toEqual([]);
  });
});

describe('the workloads a policy applies to', () => {
  const quarantine = { action: 'DENY' as const, rules: [{ from: [{ source: { namespaces: ['quarantine'] } }] }] };
  it.each<[string, AuthorizationPolicyObject, string[]]>([
    ['a policy in the root namespace applies to all 7 workloads', authorizationPolicy('istio-system', 'mesh-wide', quarantine), [gateway, coredns, api, postgres, cart, frontend, recommender]],
    ['a policy with no selector in shop applies to shop only', authorizationPolicy('shop', 'mesh-wide', quarantine), [cart, frontend, recommender]],
  ])('applied %#: %s', (_name, p, expected) => {
    const { applied } = evaluateAuthorizationPolicies(withPolicies(SHOP, p));
    expect([...applied].filter(([, refs]) => refs.some((x) => x.name === 'mesh-wide')).map(([w]) => w)).toEqual(expected);
  });
});

it('marks a workload outside the mesh: Istio does not enforce its policies', () => {
  expect([...evaluateAuthorizationPolicies(withCartMesh('none')).notEnforced]).toEqual([[cart, [ref('shop', 'cart-callers')]]]);
});

describe('istioMatch', () => {
  it.each<[string, boolean]>([
    ['cluster.local/ns/shop/sa/frontend', true],
    ['*', true],
    ['cluster.local/ns/shop/*', true],
    ['*/sa/frontend', true],
    ['cluster.local/ns/pay/*', false],
    ['cluster.local/ns/shop/sa/front', false],
    ['*/sa/cart', false],
  ])('istioMatch %#: %s', (pattern, expected) => {
    expect(istioMatch(pattern, 'cluster.local/ns/shop/sa/frontend')).toBe(expected);
  });

  // A plain-text request has no peer identity, so its principal and namespace are empty.
  it.each<[string, boolean]>([
    ['*', false],
    ['cluster.local/*', false],
    ['*/sa/frontend', false],
  ])('istioMatch on an empty value %#: %s', (pattern, expected) => {
    expect(istioMatch(pattern, '')).toBe(expected);
  });
});

describe('a call that depends on the request', () => {
  // The policies that may decide against a request are named apart from the ALLOW policy that lets it in: they allow nothing.
  it.each<[string, ClusterResources, string]>([
    [
      'a when condition on the ALLOW rule',
      withPolicies(
        SHOP,
        changed('cart-callers', (spec) => ({ ...spec, rules: (spec.rules ?? []).map((rule) => ({ ...rule, when: [{ key: 'request.headers[x-tenant]', values: ['eu'] }] })) })),
      ),
      'cart-callers',
    ],
    [
      'a CUSTOM policy, which an external service decides',
      withPolicies(SHOP, authorizationPolicy('shop', 'cart-ext-authz', { selector: onCart, action: 'CUSTOM', provider: { name: 'ext-authz' }, rules: [{ to: [{ operation: { paths: ['/cart'] } }] }] })),
      'cart-callers unless cart-ext-authz',
    ],
    [
      'a DENY that needs the request',
      withPolicies(SHOP, authorizationPolicy('shop', 'cart-deny-header', { selector: onCart, action: 'DENY', rules: [{ when: [{ key: 'request.headers[x-blocked]', values: ['1'] }] }] })),
      'cart-callers unless cart-deny-header',
    ],
    // Istio denies only the requests a DENY rule's operation matches, so the caller's other requests still get in.
    [
      'a DENY of one method',
      withPolicies(SHOP, authorizationPolicy('shop', 'cart-deny-delete', { selector: onCart, action: 'DENY', rules: [{ to: [{ operation: { methods: ['DELETE'] } }] }] })),
      'cart-callers unless cart-deny-delete',
    ],
    [
      'a DENY of the admin paths',
      withPolicies(SHOP, authorizationPolicy('shop', 'cart-deny-admin', { selector: onCart, action: 'DENY', rules: [{ to: [{ operation: { paths: ['/admin*'] } }] }] })),
      'cart-callers unless cart-deny-admin',
    ],
    [
      'a DENY of one port, which netatlas shows but does not check',
      withPolicies(SHOP, authorizationPolicy('shop', 'cart-deny-port', { selector: onCart, action: 'DENY', rules: [{ to: [{ operation: { ports: ['9090'] } }] }] })),
      'cart-callers unless cart-deny-port',
    ],
    // A common hardening: one DENY policy for the whole mesh. It must not be named beside every ALLOW policy as if it allowed the call too.
    ['a DENY in the root namespace, for every workload in the mesh, that keeps frontend from the admin paths', withPolicies(SHOP, MESH_DENY_ADMIN), 'cart-callers unless mesh-deny-admin'],
  ])('depends %#: %s', (_name, r, policies) => {
    expect(rows(r).filter(([from, to]) => from === frontend && to === cart)).toEqual([[frontend, cart, 'GET /cart', policies, DEPENDS, '']]);
  });

  describe('with no ALLOW policy, the CUSTOM and DENY policies that may match a caller make its call depend on the request', () => {
    const onPostgres = { matchLabels: { app: 'postgres' } };
    const customFor = (rules: AuthorizationPolicySpec['rules']) =>
      authorizationPolicy('payments', 'postgres-ext-authz', { selector: onPostgres, action: 'CUSTOM', provider: { name: 'ext-authz' }, rules });
    const quarantine = authorizationPolicy('payments', 'postgres-deny-quarantine', { selector: onPostgres, action: 'DENY', rules: [{ from: [{ source: { namespaces: ['quarantine'] } }] }] });
    const header = authorizationPolicy('payments', 'postgres-deny-header', {
      selector: onPostgres,
      action: 'DENY',
      rules: [{ from: [{ source: { namespaces: ['payments', 'shop'] } }], when: [{ key: 'request.headers[x-blocked]', values: ['1'] }] }],
    });
    it.each<[string, AuthorizationPolicyObject[], string[][]]>([
      [
        'a CUSTOM policy for every request reaches every caller, plain text too',
        [customFor([{}])],
        [
          [gateway, postgres, 'any request', 'unless postgres-ext-authz', DEPENDS, PLAIN],
          [coredns, postgres, 'any request', 'unless postgres-ext-authz', DEPENDS, PLAIN],
          [api, postgres, 'any request', 'unless postgres-ext-authz', DEPENDS, ''],
          [cart, postgres, 'any request', 'unless postgres-ext-authz', DEPENDS, ''],
          [frontend, postgres, 'any request', 'unless postgres-ext-authz', DEPENDS, ''],
          [recommender, postgres, 'any request', 'unless postgres-ext-authz', DEPENDS, ''],
        ],
      ],
      [
        'a CUSTOM policy for one caller and a DENY for another namespace name only the one that matches',
        [customFor([{ from: [{ source: { principals: ['cluster.local/ns/payments/sa/api'] } }] }]), quarantine],
        [[api, postgres, 'any request', 'unless postgres-ext-authz', DEPENDS, '']],
      ],
      [
        'a DENY that needs the request names itself, beside the CUSTOM policy where both match',
        [customFor([{ from: [{ source: { principals: ['cluster.local/ns/payments/sa/api'] } }] }]), header],
        [
          [api, postgres, 'any request', 'unless postgres-deny-header,postgres-ext-authz', DEPENDS, ''],
          [cart, postgres, 'any request', 'unless postgres-deny-header', DEPENDS, ''],
          [frontend, postgres, 'any request', 'unless postgres-deny-header', DEPENDS, ''],
          [recommender, postgres, 'any request', 'unless postgres-deny-header', DEPENDS, ''],
        ],
      ],
    ])('may refuse %#: %s', (_name, ps, expected) => {
      expect(rows(withPolicies(SHOP, ...ps)).filter(([, to]) => to === postgres)).toEqual(expected);
    });
  });
});

describe('a caller outside the mesh has no identity, so only rules that ask for none let it in', () => {
  it.each<[string, AuthorizationPolicyObject, string[][]]>([
    [
      'an ALLOW rule with no from',
      authorizationPolicy('shop', 'cart-callers', { selector: onCart, action: 'ALLOW', rules: [{ to: [{ operation: { methods: ['GET'] } }] }] }),
      [[gateway, cart, 'GET', 'cart-callers', '', PLAIN]],
    ],
    ['the shop policy, which names principals only', policy('cart-callers'), []],
    [
      'any principal, which needs a principal to be there',
      authorizationPolicy('shop', 'cart-callers', { selector: onCart, action: 'ALLOW', rules: [{ from: [{ source: { principals: ['*'] } }] }] }),
      [],
    ],
    [
      'every principal but one, which a request without one is not',
      authorizationPolicy('shop', 'cart-callers', { selector: onCart, action: 'ALLOW', rules: [{ from: [{ source: { notPrincipals: ['cluster.local/ns/shop/sa/recommender'] } }] }] }),
      [[gateway, cart, 'any request', 'cart-callers', '', PLAIN]],
    ],
  ])('outside the mesh %#: %s', (_name, p, expected) => {
    expect(rows(withPolicies(SHOP, p)).filter(([from, to]) => from === gateway && to === cart)).toEqual(expected);
  });
});

describe('the other identity fields of a source', () => {
  const allowCart = (rule: NonNullable<AuthorizationPolicySpec['rules']>[number]) =>
    authorizationPolicy('shop', 'cart-callers', { selector: onCart, action: 'ALLOW', rules: [rule] });
  it.each<[string, AuthorizationPolicyObject, string[][]]>([
    ['serviceAccounts naming frontend admits frontend only', allowCart({ from: [{ source: { serviceAccounts: ['shop/frontend'] } }] }), [[frontend, cart, 'any request', 'cart-callers', '', '']]],
    [
      'serviceAccounts without a namespace means the policy namespace',
      allowCart({ from: [{ source: { serviceAccounts: ['frontend'] } }] }),
      [[frontend, cart, 'any request', 'cart-callers', '', '']],
    ],
    [
      'notServiceAccounts naming frontend admits the others, plain text too',
      allowCart({ from: [{ source: { notServiceAccounts: ['shop/frontend'] } }] }),
      [
        [gateway, cart, 'any request', 'cart-callers', '', PLAIN],
        [recommender, cart, 'any request', 'cart-callers', '', ''],
      ],
    ],
    [
      'trustDomains matching the cluster admits the callers in the mesh only',
      allowCart({ from: [{ source: { trustDomains: ['cluster.*'] } }] }),
      [
        [frontend, cart, 'any request', 'cart-callers', '', ''],
        [recommender, cart, 'any request', 'cart-callers', '', ''],
      ],
    ],
    ['notTrustDomains naming the cluster admits plain text only', allowCart({ from: [{ source: { notTrustDomains: ['cluster.local'] } }] }), [[gateway, cart, 'any request', 'cart-callers', '', PLAIN]]],
  ])('identity %#: %s', (_name, p, expected) => {
    expect(rows(withPolicies(SHOP, p)).filter(([from, to]) => [gateway, frontend, recommender].includes(from ?? '') && to === cart)).toEqual(expected);
  });
});

describe('a field netatlas does not know makes the rule depend on the request, never allow any source', () => {
  const frontendOnly = { source: { principals: ['cluster.local/ns/shop/sa/frontend'] } };
  it.each<[string, NonNullable<AuthorizationPolicySpec['rules']>[number], string[][]]>([
    [
      'in a source',
      { from: [{ source: { sourceLabels: ['team=shop'] } }] },
      [
        [gateway, cart, 'any request', 'cart-callers', DEPENDS, PLAIN],
        [frontend, cart, 'any request', 'cart-callers', DEPENDS, ''],
        [recommender, cart, 'any request', 'cart-callers', DEPENDS, ''],
      ],
    ],
    [
      'beside source in a from entry',
      { from: [{ origin: { principals: ['cluster.local/ns/shop/sa/frontend'] } }] },
      [
        [gateway, cart, 'any request', 'cart-callers', DEPENDS, PLAIN],
        [frontend, cart, 'any request', 'cart-callers', DEPENDS, ''],
        [recommender, cart, 'any request', 'cart-callers', DEPENDS, ''],
      ],
    ],
    ['in an operation', { from: [frontendOnly], to: [{ operation: { methods: ['GET'], headerNames: ['x-user'] } }] }, [[frontend, cart, 'GET', 'cart-callers', DEPENDS, '']]],
    ['in the rule itself', { from: [frontendOnly], audiences: ['shop'] }, [[frontend, cart, 'any request', 'cart-callers', DEPENDS, '']]],
  ])('unknown %#: %s', (_name, rule, expected) => {
    const p = authorizationPolicy('shop', 'cart-callers', { selector: onCart, action: 'ALLOW', rules: [rule] });
    expect(rows(withPolicies(SHOP, p)).filter(([from, to]) => [gateway, frontend, recommender].includes(from ?? '') && to === cart)).toEqual(expected);
  });
});

it('does not evaluate a policy attached to a waypoint by targetRefs', () => {
  const waypoint = authorizationPolicy('shop', 'cart-waypoint', {
    targetRefs: [{ group: 'gateway.networking.k8s.io', kind: 'Gateway', name: 'waypoint' }],
    action: 'ALLOW',
    rules: [{ from: [{ source: { principals: ['cluster.local/ns/shop/sa/recommender'] } }] }],
  });
  expect(evaluateAuthorizationPolicies(withPolicies(SHOP, waypoint)).notEvaluated).toEqual([ref('shop', 'cart-waypoint')]);
});

it('ignores an AUDIT policy, which only logs', () => {
  const audit = authorizationPolicy('shop', 'cart-audit', { selector: onCart, action: 'AUDIT', rules: [{}] });
  const r = withPolicies(SHOP, audit);
  expect([rows(r), evaluateAuthorizationPolicies(r).applied.get(cart)]).toEqual([SHOP_EDGES, [ref('shop', 'cart-callers')]]);
});

it('matches principals in the cluster trust domain only: example.org gives no edges', () => {
  expect(rows({ ...SHOP, istioSettings: { ...SHOP.istioSettings, trustDomain: 'example.org' } })).toEqual([]);
});

// ztunnel, the only proxy of an ambient destination without a waypoint, cannot read HTTP: an ALLOW rule
// with an HTTP attribute never matches, and a DENY rule enforces only its other attributes
// (https://istio.io/latest/docs/ambient/usage/l4-policy/, "Policies with Layer 7 conditions").
describe('an ambient destination applies only the attributes ztunnel can read', () => {
  const frontendOnly = { source: { principals: ['cluster.local/ns/shop/sa/frontend'] } };
  const allowFrontend = authorizationPolicy('shop', 'cart-callers', { selector: onCart, action: 'ALLOW', rules: [{ from: [frontendOnly] }] });
  const ambient = (...ps: AuthorizationPolicyObject[]) => rows(withPolicies(withCartMesh('ambient'), ...ps)).filter(([from, to]) => from === frontend && to === cart);
  const deny = (name: string, rules: AuthorizationPolicySpec['rules']) => authorizationPolicy('shop', name, { selector: onCart, action: 'DENY', rules });
  it.each<[string, AuthorizationPolicyObject[], string[][]]>([
    ['an ALLOW rule with a method and path never matches, so nothing gets in', [policy('cart-callers')], []],
    // Istio never sends a CUSTOM policy to ztunnel ("ztunnel does not support the CUSTOM action").
    [
      'a CUSTOM policy decides nothing',
      [allowFrontend, authorizationPolicy('shop', 'cart-ext-authz', { selector: onCart, action: 'CUSTOM', provider: { name: 'ext-authz' }, rules: [{}] })],
      [[frontend, cart, 'any request', 'cart-callers', '', '']],
    ],
    // ztunnel's source match has no trust domain, so the field is dropped, and a source left empty matches nothing.
    ['an ALLOW source with only trustDomains matches nothing', [authorizationPolicy('shop', 'cart-callers', { selector: onCart, action: 'ALLOW', rules: [{ from: [{ source: { trustDomains: ['cluster.local'] } }] }] })], []],
    [
      'an ALLOW source with a principal and another trust domain still matches the principal',
      [authorizationPolicy('shop', 'cart-callers', { selector: onCart, action: 'ALLOW', rules: [{ from: [{ source: { principals: ['cluster.local/ns/shop/sa/frontend'], trustDomains: ['example.org'] } }] }] })],
      [[frontend, cart, 'any request', 'cart-callers', '', '']],
    ],
    ['a DENY source with only notTrustDomains matches nothing', [allowFrontend, deny('cart-deny-foreign', [{ from: [{ source: { notTrustDomains: ['example.org'] } }] }])], [[frontend, cart, 'any request', 'cart-callers', '', '']]],
    [
      'an ALLOW rule with a JWT principal never matches',
      [authorizationPolicy('shop', 'cart-callers', { selector: onCart, action: 'ALLOW', rules: [{ from: [{ source: { principals: ['cluster.local/ns/shop/sa/frontend'], requestPrincipals: ['*'] } }] }] })],
      [],
    ],
    [
      'an ALLOW rule with an HTTP condition never matches',
      [authorizationPolicy('shop', 'cart-callers', { selector: onCart, action: 'ALLOW', rules: [{ from: [frontendOnly], when: [{ key: 'request.headers[x-team]', values: ['shop'] }] }] })],
      [],
    ],
    [
      'an ALLOW rule with a port only still matches',
      [authorizationPolicy('shop', 'cart-callers', { selector: onCart, action: 'ALLOW', rules: [{ from: [frontendOnly], to: [{ operation: { ports: ['8080'] } }] }] })],
      [[frontend, cart, 'port 8080', 'cart-callers', '', '']],
    ],
    ['a DENY rule with only a method is skipped and blocks nothing', [allowFrontend, deny('cart-deny-delete', [{ to: [{ operation: { methods: ['DELETE'] } }] }])], [[frontend, cart, 'any request', 'cart-callers', '', '']]],
    [
      'a DENY rule with the caller in one entry and a method in another never matches',
      [allowFrontend, deny('cart-deny-delete', [{ from: [frontendOnly], to: [{ operation: { methods: ['DELETE'] } }] }])],
      [[frontend, cart, 'any request', 'cart-callers', '', '']],
    ],
    ['a DENY rule with an HTTP condition never matches', [allowFrontend, deny('cart-deny-header', [{ from: [frontendOnly], when: [{ key: 'request.headers[x-blocked]', values: ['1'] }] }])], [[frontend, cart, 'any request', 'cart-callers', '', '']]],
    ['a DENY rule with the caller and a JWT principal in one entry denies the caller', [allowFrontend, deny('cart-deny-jwt', [{ from: [{ source: { principals: ['cluster.local/ns/shop/sa/frontend'], notRequestPrincipals: ['*'] } }] }])], []],
    [
      'a DENY rule with a port and a method in one entry denies that port, which netatlas does not check',
      [allowFrontend, deny('cart-deny-port', [{ to: [{ operation: { ports: ['8080'], methods: ['DELETE'] } }] }])],
      [[frontend, cart, 'any request', 'cart-callers unless cart-deny-port', DEPENDS, '']],
    ],
  ])('ambient %#: %s', (_name, ps, expected) => {
    expect(ambient(...ps)).toEqual(expected);
  });
});

// cart's first pod is the canary, its other two stable, each under its own ALLOW policy: frontend may call
// the stable pods only and api the canary only, so neither pair is refused as a whole. The callers neither
// admits are refused by every pod, and are listed.
it('lists a pair as refused only when Istio refuses it on every pod of the callee', () => {
  const canary = 'cart-6d5f7c9b8-4xkqz';
  const twoTracks: ClusterResources = withPolicies(
    { ...SHOP, pods: SHOP.pods.map((p) => (p.workload.name === 'cart' ? { ...p, labels: { ...p.labels, track: p.name === canary ? 'canary' : 'stable' } } : p)) },
    changed('cart-callers', (spec) => ({ ...spec, selector: { matchLabels: { app: 'cart', track: 'stable' } } })),
    authorizationPolicy('shop', 'cart-canary-callers', {
      selector: { matchLabels: { app: 'cart', track: 'canary' } },
      action: 'ALLOW',
      rules: [{ from: [{ source: { principals: ['cluster.local/ns/payments/sa/api'] } }] }],
    }),
  );
  expect(evaluateAuthorizationPolicies(twoTracks).denied.filter((p) => p.to === cart)).toStrictEqual([
    { from: gateway, to: cart },
    { from: coredns, to: cart },
    { from: postgres, to: cart },
    { from: recommender, to: cart },
  ]);
});
