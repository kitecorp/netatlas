import { describe, expect, it } from 'vitest';
import { authorizationPolicy, SHOP, withPolicies } from './fixtures/shop';
import { mapState, toFlow } from './flow';
import { clusterGraph, defaultHidden } from './graph';

const BOTH = { networkpolicy: true, istio: true };
const shop = (show = BOTH, hidden = defaultHidden(SHOP)) => toFlow(clusterGraph(SHOP), { hidden, show });

describe('toFlow', () => {
  it('counts the workloads, the policies and the open workloads it shows', () => {
    expect(shop().counts).toStrictEqual({ workloads: 6, policies: 7, noPolicy: 1 });
  });

  it('puts each shown namespace before its workloads, and the Internet as one node', () => {
    expect(shop().nodes).toStrictEqual([
      { id: 'namespace:ingress', type: 'namespace', label: 'namespace ingress', sub: '', tone: 'normal' },
      { id: 'ingress/Deployment/gateway', type: 'workload', parent: 'namespace:ingress', label: 'gateway', sub: '2 pods · 1 policy', tone: 'normal' },
      { id: 'namespace:payments', type: 'namespace', label: 'namespace payments', sub: '', tone: 'normal' },
      { id: 'payments/Deployment/api', type: 'workload', parent: 'namespace:payments', label: 'api', sub: '2 pods · 2 policies', tone: 'normal' },
      { id: 'payments/Deployment/postgres', type: 'workload', parent: 'namespace:payments', label: 'postgres', sub: '1 pod · 1 policy', tone: 'normal', marks: ['may call anything'] },
      { id: 'namespace:shop', type: 'namespace', label: 'namespace shop', sub: '', tone: 'normal' },
      { id: 'shop/Deployment/cart', type: 'workload', parent: 'namespace:shop', label: 'cart', sub: '3 pods · 2 policies', tone: 'normal' },
      { id: 'shop/Deployment/frontend', type: 'workload', parent: 'namespace:shop', label: 'frontend', sub: '2 pods · 1 policy', tone: 'normal' },
      { id: 'shop/Deployment/recommender', type: 'workload', parent: 'namespace:shop', label: 'recommender', sub: '1 pod · no policy', tone: 'open' },
      { id: 'outside', type: 'outside', label: 'Internet', sub: 'outside the cluster', tone: 'normal' },
    ]);
  });

  it('labels each edge with who calls whom, on what, and which kind of policy allows it', () => {
    expect(shop().edges.map((e) => e.ariaLabel)).toStrictEqual([
      'From gateway to frontend, TCP 8080, allowed by a NetworkPolicy',
      'From Internet to gateway, TCP 443, allowed by a NetworkPolicy',
      'From api to postgres, TCP 5432, allowed by a NetworkPolicy',
      'From cart to api, POST /pay, allowed by an Istio AuthorizationPolicy',
      'From cart to api, TCP 8443, allowed by a NetworkPolicy',
      'From frontend to cart, GET /cart, allowed by an Istio AuthorizationPolicy',
      'From frontend to cart, TCP 8080, allowed by a NetworkPolicy',
      'From recommender to postgres, TCP 5432, allowed by a NetworkPolicy',
    ]);
  });

  it('draws edges between node ids, with the label shown on the line', () => {
    expect(shop().edges.slice(0, 2).map(({ source, target, kind, label }) => ({ source, target, kind, label }))).toStrictEqual([
      { source: 'ingress/Deployment/gateway', target: 'shop/Deployment/frontend', kind: 'networkpolicy', label: 'TCP 8080' },
      { source: 'outside', target: 'ingress/Deployment/gateway', kind: 'networkpolicy', label: 'TCP 443' },
    ]);
  });

  it('with Istio off, keeps only the NetworkPolicy edges', () => {
    expect(shop({ networkpolicy: true, istio: false }).edges.map((e) => e.kind)).toStrictEqual(Array(6).fill('networkpolicy'));
  });

  it('leaves out a hidden namespace, its workloads and their edges, and the Internet when no edge reaches it', () => {
    const f = shop(BOTH, new Set(['kube-system', 'ingress']));
    expect([f.nodes.map((n) => n.id).filter((id) => !id.startsWith('shop/') && !id.startsWith('payments/')), f.edges.length, f.counts]).toStrictEqual([
      ['namespace:payments', 'namespace:shop'],
      6,
      { workloads: 5, policies: 6, noPolicy: 1 },
    ]);
  });

  it('adds what an edge depends on to its label, and marks a rule with no peers on its workload', () => {
    const anyGet = authorizationPolicy('shop', 'cart-get', { selector: { matchLabels: { app: 'cart' } }, action: 'ALLOW', rules: [{ to: [{ operation: { methods: ['GET'] } }], when: [{ key: 'request.headers[x-team]', values: ['shop'] }] }] });
    const open = { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: { name: 'frontend-any', namespace: 'shop' }, spec: { podSelector: { matchLabels: { app: 'frontend' } }, policyTypes: ['Ingress' as const], ingress: [{ ports: [{ protocol: 'TCP' as const, port: 8080 }] }] } };
    const f = toFlow(clusterGraph(withPolicies(SHOP, anyGet, open)), { hidden: defaultHidden(SHOP), show: BOTH });
    const toCart = (from: string) => f.edges.filter((e) => e.source === from && e.target === 'shop/Deployment/cart' && e.label === 'GET').map((e) => e.ariaLabel);
    expect([toCart('shop/Deployment/frontend'), toCart('ingress/Deployment/gateway'), f.nodes.find((n) => n.label === 'frontend')?.marks]).toStrictEqual([
      ['From frontend to cart, GET, allowed by an Istio AuthorizationPolicy, depends on the request'],
      ['From gateway to cart, GET, allowed by an Istio AuthorizationPolicy, depends on the request, accepted unless mutual TLS is STRICT'],
      ['any caller on TCP 8080'],
    ]);
  });
});

describe('toFlow open marks', () => {
  const marksAfter = (...policies: Parameters<typeof withPolicies>[1][]) => {
    const f = toFlow(clusterGraph(withPolicies(SHOP, ...policies)), { hidden: defaultHidden(SHOP), show: BOTH });
    const node = f.nodes.find((n) => n.label === 'recommender');
    return { tone: node?.tone, marks: node?.marks };
  };

  it('marks both sides open on a workload only an Istio policy selects', () => {
    const recommenderCallers = authorizationPolicy('shop', 'recommender-callers', { selector: { matchLabels: { app: 'recommender' } }, action: 'ALLOW', rules: [{ to: [{ operation: { methods: ['GET'] } }] }] });
    // The network lets any caller through, but the enforced Istio policy decides which requests reach it.
    expect(marksAfter(recommenderCallers)).toStrictEqual({ tone: 'normal', marks: ['any caller on the network', 'may call anything'] });
  });

  it('marks the open egress side after the peerless ingress rule of a policy that restricts only ingress', () => {
    const anyIn = { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: { name: 'recommender-any', namespace: 'shop' }, spec: { podSelector: { matchLabels: { app: 'recommender' } }, policyTypes: ['Ingress' as const], ingress: [{ ports: [{ protocol: 'TCP' as const, port: 8080 }] }] } };
    expect(marksAfter(anyIn)).toStrictEqual({ tone: 'normal', marks: ['any caller on TCP 8080', 'may call anything'] });
  });

  it('marks the open ingress side of a workload whose policy restricts only egress', () => {
    const outOnly = { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: { name: 'recommender-out', namespace: 'shop' }, spec: { podSelector: { matchLabels: { app: 'recommender' } }, policyTypes: ['Egress' as const], egress: [{ to: [{ podSelector: { matchLabels: { app: 'cart' } } }], ports: [{ protocol: 'TCP' as const, port: 8080 }] }] } };
    expect(marksAfter(outOnly)).toStrictEqual({ tone: 'normal', marks: ['any caller'] });
  });

  it('gives a workload no policy selects its open tone and no marks', () => {
    expect(marksAfter()).toStrictEqual({ tone: 'open', marks: undefined });
  });
});

describe('mapState', () => {
  const all = ['ingress', 'kube-system', 'payments', 'shop'];
  const state = (params: Record<string, string | string[] | undefined>) => {
    const s = mapState(params, all, new Set(['kube-system', 'istio-system']));
    return { hidden: [...s.hidden], show: s.show, selected: s.selected, query: s.query };
  };

  it.each<[string, Record<string, string | string[] | undefined>, ReturnType<typeof state>]>([
    ['no parameters: every namespace but the default hidden ones, both kinds', {}, { hidden: ['kube-system'], show: { networkpolicy: true, istio: true }, selected: undefined, query: '' }],
    ['the namespaces named in ns', { ns: 'shop,kube-system' }, { hidden: ['ingress', 'payments'], show: { networkpolicy: true, istio: true }, selected: undefined, query: '' }],
    ['an empty ns, which hides every namespace', { ns: '' }, { hidden: all, show: { networkpolicy: true, istio: true }, selected: undefined, query: '' }],
    ['show with one kind', { show: 'networkpolicy' }, { hidden: ['kube-system'], show: { networkpolicy: true, istio: false }, selected: undefined, query: '' }],
    ['the chosen workload and the search', { w: 'shop/Deployment/cart', q: ' cart ' }, { hidden: ['kube-system'], show: { networkpolicy: true, istio: true }, selected: 'shop/Deployment/cart', query: 'cart' }],
    ['a parameter given twice, of which the first counts', { w: ['shop/Deployment/cart', 'x'] }, { hidden: ['kube-system'], show: { networkpolicy: true, istio: true }, selected: 'shop/Deployment/cart', query: '' }],
  ])('reads %s', (_name, params, expected) => {
    expect(state(params)).toStrictEqual(expected);
  });
});
