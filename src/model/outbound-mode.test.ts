import { describe, expect, it } from 'vitest';
import { podClasses, type PodClass } from './classes';
import { OUTBOUND, serviceEntry, sidecar, withSidecars } from './fixtures/outbound';
import { networkPolicy, withPolicies } from './fixtures/shop';
import { netpolEvaluator } from './netpol';
import { istioLayer, istioVerdict, netpolVerdict, serviceEntryTargets, type IstioLayer, type NetpolTarget, type Verdict } from './outbound-mode';
import type { ClusterResources, MeshSettings, PodInfo, ServiceEntryObject, SidecarObject } from './types';

// Class ids: podClasses numbers each workload's classes in the order its pods come.
const recommender = 'shop/Deployment/recommender#0';
const cart = 'shop/Deployment/cart#0';
const frontend = 'shop/Deployment/frontend#0';
const api = 'payments/Deployment/api#0';
const gateway = 'ingress/Deployment/gateway#0';

const classOf = (r: ClusterResources, id: string): PodClass => {
  const c = podClasses(r.pods).find((x) => x.id === id);
  if (!c) throw new Error(`no pod class ${id}`);
  return c;
};

const withMesh = (meshConfig: MeshSettings): ClusterResources => ({ ...OUTBOUND, meshConfig });

const recommenderPod = (() => {
  const p = OUTBOUND.pods.find((x) => x.labels.app === 'recommender');
  if (!p) throw new Error('OUTBOUND has no recommender pod');
  return p;
})();

/** OUTBOUND with recommender's one pod changed. */
const withRecommender = (change: Partial<PodInfo>): ClusterResources => ({
  ...OUTBOUND,
  pods: OUTBOUND.pods.map((p) => (p === recommenderPod ? { ...p, ...change } : p)),
});

/**
 * OUTBOUND with a second recommender pod on Istio revision canary, after the first, as during a canary
 * upgrade. podClasses keeps the revision in its key and in the class, so the canary pod is its own class
 * `#1`: a podClasses that dropped the revision from its key has no `#1`, and one that dropped it from the
 * class gives `#1` the default revision's layer.
 */
const CANARY: ClusterResources = { ...OUTBOUND, pods: [...OUTBOUND.pods, { ...recommenderPod, name: 'recommender-6f9b7c5d4-v8k3t', istioRevision: 'canary' }] };

const rootRegistryOnly = sidecar('istio-system', 'default', { outboundTrafficPolicy: { mode: 'REGISTRY_ONLY' } });

const cartAllowAny = (creationTimestamp: string) =>
  sidecar('shop', 'cart-allow-any', { workloadSelector: { labels: { app: 'cart' } }, outboundTrafficPolicy: { mode: 'ALLOW_ANY' } }, creationTimestamp);

/** A REGISTRY_ONLY Sidecar of recommender's with the egress given. */
const recommenderSidecar = (name: string, egress: NonNullable<SidecarObject['spec']['egress']>) =>
  sidecar('shop', name, { workloadSelector: { labels: { app: 'recommender' } }, outboundTrafficPolicy: { mode: 'REGISTRY_ONLY' }, egress });

/** A pod of one of Istio's own proxies: its container is istio-proxy, so the reader gives it mesh `sidecar`. */
const proxyPod = (namespace: string, name: string, labels: PodInfo['labels']): PodInfo => ({
  name: `${name}-7f9d8c6b5-x4k2m`,
  namespace,
  labels,
  serviceAccount: name,
  workload: { kind: 'Deployment', name },
  phase: 'Running',
  ports: [],
  mesh: 'sidecar',
});

const withPods = (r: ClusterResources, ...pods: readonly PodInfo[]): ClusterResources => ({ ...r, pods: [...r.pods, ...pods] });

const INGRESS_GATEWAY = proxyPod('istio-system', 'istio-ingressgateway', { app: 'istio-ingressgateway', istio: 'ingressgateway' });
const EGRESS_GATEWAY = proxyPod('istio-system', 'istio-egressgateway', { app: 'istio-egressgateway', istio: 'egressgateway' });
const WAYPOINT = proxyPod('shop', 'waypoint', { 'gateway.networking.k8s.io/gateway-name': 'waypoint', 'gateway.networking.k8s.io/gateway-class-name': 'istio-waypoint' });
/** A pod of Istio's gateway Helm chart installed as istio-ingress: labelled istio=ingress, its proxy run as router. */
const CHART_GATEWAY: PodInfo = { ...proxyPod('istio-ingress', 'istio-ingress', { app: 'istio-ingress', istio: 'ingress' }), proxyRole: 'router' };
/** A waypoint known by its proxy's role alone, without the gateway-name label. */
const ROLE_WAYPOINT: PodInfo = { ...proxyPod('shop', 'mesh-waypoint', { app: 'mesh-waypoint' }), proxyRole: 'waypoint' };
/**
 * The chart's Deployment while its pods move from the sidecar template to the gateway one: the old pod's
 * proxy runs as sidecar, the new one's as router, after it. podClasses keeps the role in its key and in the
 * class, so the router pod is its own class `#1`: without it in the key there is no `#1`, and without it in
 * the class `#1` reads the outbound mode.
 */
const CHART_ROLLOUT = withPods(OUTBOUND, { ...CHART_GATEWAY, name: 'istio-ingress-5d8c7b9f6-h3j5k', proxyRole: 'sidecar' }, CHART_GATEWAY);

/** OUTBOUND as the reader gives it when the role may not list Sidecars: none of them, and the kind in readErrors. */
const SIDECARS_UNREADABLE: ClusterResources = { ...OUTBOUND, sidecars: [], readErrors: [{ kind: 'sidecars', reason: 'forbidden' }] };
/** OUTBOUND as the reader gives it when the role may not list ServiceEntries. */
const SERVICE_ENTRIES_UNREADABLE: ClusterResources = { ...OUTBOUND, serviceEntries: [], readErrors: [{ kind: 'serviceentries', reason: 'forbidden' }] };

/**
 * istiod's pod as the istiod chart deploys it, its discovery container run with SHARED_MESH_CONFIG set:
 * istiod then loads that ConfigMap as a second mesh config (pilot/pkg/bootstrap/mesh.go:112-114).
 */
const SHARED_ISTIOD: PodInfo = {
  name: 'istiod-79f74bbfc4-fbprk',
  namespace: 'istio-system',
  labels: { app: 'istiod', istio: 'pilot' },
  serviceAccount: 'istiod',
  workload: { kind: 'Deployment', name: 'istiod' },
  phase: 'Running',
  ports: [{ name: 'grpc-xds', port: 15012, protocol: 'TCP' }],
  mesh: 'none',
  sharedMeshConfig: 'istio-shared',
};

/** A Sidecar with no spec: the CRD admits it (crd-all.gen.yaml has no top-level `required`), only Istio's webhook refuses it. */
const NO_SPEC = { apiVersion: 'networking.istio.io/v1', kind: 'Sidecar', metadata: { name: 'empty', namespace: 'shop' } } as unknown as SidecarObject;

describe('the Istio layer of each workload', () => {
  it.each<[string, ClusterResources, string, IstioLayer['kind'], string]>([
    ['OUTBOUND, recommender', OUTBOUND, recommender, 'any-domain', "any domain (ALLOW_ANY, Istio's default)"],
    ['OUTBOUND, api', OUTBOUND, api, 'registry-only', 'only the hosts listed (REGISTRY_ONLY, Sidecar payments/registry-only)'],
    // outboundTrafficPolicy without a mode in a Sidecar is REGISTRY_ONLY, the proto's zero value.
    ['OUTBOUND, cart', OUTBOUND, cart, 'registry-only', 'only the hosts listed (REGISTRY_ONLY, Sidecar shop/cart-registry)'],
    [
      'OUTBOUND, frontend',
      OUTBOUND,
      frontend,
      'depends',
      'depends: the Sidecar shop/frontend-tilde lists egress hosts netatlas does not evaluate (~/*.fonts.example)',
    ],
    ['OUTBOUND, gateway', OUTBOUND, gateway, 'not-in-mesh', 'not in the mesh'],
    ['mesh config forbidden, recommender', withMesh({ state: 'forbidden' }), recommender, 'depends', "depends: netatlas's role may not read the ConfigMap istio"],
    // Its Sidecar sets the mode, but which ServiceEntries it sees depends on the mesh config.
    ['mesh config forbidden, api', withMesh({ state: 'forbidden' }), api, 'depends', "depends: netatlas's role may not read the ConfigMap istio"],
    ['mesh config missing, recommender', withMesh({ state: 'missing' }), recommender, 'depends', 'depends: the ConfigMap istio is missing'],
    ['mesh config unparsable, recommender', withMesh({ state: 'unparsable' }), recommender, 'depends', 'depends: the mesh config is not valid YAML'],
    [
      'no networking.istio.io, recommender',
      { ...OUTBOUND, serviceEntries: 'not-installed', sidecars: 'not-installed', meshConfig: { state: 'not-installed' } },
      recommender,
      'depends',
      'depends: the cluster serves no networking.istio.io API',
    ],
    [
      'outbound without a mode, recommender',
      withMesh({ state: 'found', outbound: 'no-mode' }),
      recommender,
      'depends',
      'depends: the mesh config sets outboundTrafficPolicy without a mode',
    ],
    [
      'outbound mode 2, recommender',
      withMesh({ state: 'found', outbound: { other: '2' } }),
      recommender,
      'depends',
      'depends: the mesh config sets the outbound mode 2, which netatlas does not know',
    ],
    [
      'mesh ALLOW_ANY_DYNAMIC_DNS, recommender',
      withMesh({ state: 'found', outbound: 'ALLOW_ANY_DYNAMIC_DNS' }),
      recommender,
      'any-domain',
      'any domain (ALLOW_ANY_DYNAMIC_DNS, the mesh config)',
    ],
    // serviceEntryVisibility is a message (config.proto:1785-1835). With applyToSidecars, istiod narrows the
    // entries a sidecar sees by it: NAMESPACE keeps an entry to its own namespace, NONE hides it (push_context.go:1082-1094).
    [
      'root Sidecar, NAMESPACE for sidecars, recommender',
      withSidecars(withMesh({ state: 'found', outbound: 'unset', serviceEntryVisibility: { applyToSidecars: true, defaultVisibility: 'NAMESPACE', policies: 0 } }), rootRegistryOnly),
      recommender,
      'depends',
      'depends: the mesh sets serviceEntryVisibility for sidecars, which netatlas does not evaluate',
    ],
    // Policies match ServiceEntries by their namespace's labels, which netatlas does not evaluate.
    [
      'root Sidecar, PUBLIC with a policy, for sidecars, recommender',
      withSidecars(withMesh({ state: 'found', outbound: 'unset', serviceEntryVisibility: { applyToSidecars: true, defaultVisibility: 'PUBLIC', policies: 1 } }), rootRegistryOnly),
      recommender,
      'depends',
      'depends: the mesh sets serviceEntryVisibility for sidecars, which netatlas does not evaluate',
    ],
    [
      'root Sidecar, PUBLIC for sidecars, recommender',
      withSidecars(withMesh({ state: 'found', outbound: 'unset', serviceEntryVisibility: { applyToSidecars: true, defaultVisibility: 'PUBLIC', policies: 0 } }), rootRegistryOnly),
      recommender,
      'registry-only',
      'only the hosts listed (REGISTRY_ONLY, Sidecar istio-system/default)',
    ],
    // Without applyToSidecars only ztunnel and waypoints apply it; sidecars keep exportTo (push_context.go:1082).
    [
      'root Sidecar, NAMESPACE for ambient only, recommender',
      withSidecars(withMesh({ state: 'found', outbound: 'unset', serviceEntryVisibility: { applyToSidecars: false, defaultVisibility: 'NAMESPACE', policies: 0 } }), rootRegistryOnly),
      recommender,
      'registry-only',
      'only the hosts listed (REGISTRY_ONLY, Sidecar istio-system/default)',
    ],
    // payments/registry-only sets REGISTRY_ONLY; a Sidecar netatlas may not read could set either mode.
    ['Sidecars unreadable, api', SIDECARS_UNREADABLE, api, 'depends', "depends: netatlas's role may not read Sidecars"],
    // Under REGISTRY_ONLY the listed hosts come from the ServiceEntries.
    ['ServiceEntries unreadable, api', SERVICE_ENTRIES_UNREADABLE, api, 'depends', "depends: netatlas's role may not read ServiceEntries"],
    // Under ALLOW_ANY every domain is open whatever the ServiceEntries list.
    ['ServiceEntries unreadable, recommender', SERVICE_ENTRIES_UNREADABLE, recommender, 'any-domain', "any domain (ALLOW_ANY, Istio's default)"],
    ['istiod reads a second mesh config, recommender', withPods(OUTBOUND, SHARED_ISTIOD), recommender, 'depends', 'depends: istiod also reads the ConfigMap istio-shared, which netatlas does not read'],
    // Only istiod's own pods load a mesh config.
    ['SHARED_MESH_CONFIG on a pod that is not istiod, recommender', withRecommender({ sharedMeshConfig: 'istio-shared' }), recommender, 'any-domain', "any domain (ALLOW_ANY, Istio's default)"],
    // The Sidecar without a spec governs shop as one without a selector does: no outbound policy, egress */*.
    ['a Sidecar with no spec, REGISTRY_ONLY mesh, recommender', withSidecars(withMesh({ state: 'found', outbound: 'REGISTRY_ONLY' }), NO_SPEC), recommender, 'registry-only', 'only the hosts listed (REGISTRY_ONLY, the mesh config)'],
    ['root Sidecar, recommender', withSidecars(OUTBOUND, rootRegistryOnly), recommender, 'registry-only', 'only the hosts listed (REGISTRY_ONLY, Sidecar istio-system/default)'],
    // The namespace's own Sidecar comes before the root namespace's.
    ['root Sidecar, api', withSidecars(OUTBOUND, rootRegistryOnly), api, 'registry-only', 'only the hosts listed (REGISTRY_ONLY, Sidecar payments/registry-only)'],
    [
      'revision canary, recommender#1',
      CANARY,
      'shop/Deployment/recommender#1',
      'depends',
      'depends: the pod runs Istio revision canary, whose mesh config netatlas does not read',
    ],
    ['revision default, recommender', withRecommender({ istioRevision: 'default' }), recommender, 'any-domain', "any domain (ALLOW_ANY, Istio's default)"],
    ['ambient, recommender', withRecommender({ mesh: 'ambient' }), recommender, 'any-domain', 'any domain: ztunnel passes unknown traffic through'],
    // Of two selector Sidecars, the older applies; added last, so neither list order nor name alone picks it.
    ['older ALLOW_ANY Sidecar, cart', withSidecars(OUTBOUND, cartAllowAny('2026-11-01T00:00:00Z')), cart, 'any-domain', 'any domain (ALLOW_ANY, Sidecar shop/cart-allow-any)'],
    // Created after cart-registry: its earlier name does not make it apply.
    [
      'newer ALLOW_ANY Sidecar, cart',
      withSidecars(OUTBOUND, cartAllowAny('2026-11-03T00:00:00Z')),
      cart,
      'registry-only',
      'only the hosts listed (REGISTRY_ONLY, Sidecar shop/cart-registry)',
    ],
    // A Sidecar whose selector matches comes before the namespace's Sidecar without one.
    [
      'shop-wide ALLOW_ANY Sidecar, cart',
      withSidecars(OUTBOUND, sidecar('shop', 'default', { outboundTrafficPolicy: { mode: 'ALLOW_ANY' } })),
      cart,
      'registry-only',
      'only the hosts listed (REGISTRY_ONLY, Sidecar shop/cart-registry)',
    ],
    [
      'one-port listener, recommender',
      withSidecars(OUTBOUND, recommenderSidecar('recommender-one-port', [{ port: { number: 443, protocol: 'TLS', name: 'tls' }, hosts: ['*/*'] }])),
      recommender,
      'depends',
      'depends: the Sidecar shop/recommender-one-port limits an egress listener to one port',
    ],
    // A host needs exactly one `/`.
    [
      'host with no namespace, recommender',
      withSidecars(OUTBOUND, recommenderSidecar('recommender-bare-host', [{ hosts: ['api.partner.example'] }])),
      recommender,
      'depends',
      'depends: the Sidecar shop/recommender-bare-host lists egress hosts netatlas does not evaluate (api.partner.example)',
    ],
    // Gateways and waypoints ignore Sidecars and the mesh's outbound mode (push_context.go:1170-1174).
    [
      'ingress gateway, istio-system',
      withPods(OUTBOUND, INGRESS_GATEWAY),
      'istio-system/Deployment/istio-ingressgateway#0',
      'depends',
      'depends: a gateway or waypoint forwards only what its routes name, and netatlas does not read them',
    ],
    // Under a REGISTRY_ONLY mesh config too.
    [
      'egress gateway, REGISTRY_ONLY mesh',
      withPods(withMesh({ state: 'found', outbound: 'REGISTRY_ONLY' }), EGRESS_GATEWAY),
      'istio-system/Deployment/istio-egressgateway#0',
      'depends',
      'depends: a gateway or waypoint forwards only what its routes name, and netatlas does not read them',
    ],
    [
      'waypoint, shop',
      withPods(OUTBOUND, WAYPOINT),
      'shop/Deployment/waypoint#0',
      'depends',
      'depends: a gateway or waypoint forwards only what its routes name, and netatlas does not read them',
    ],
    // Gateways the round 1 labels miss are known by the role their proxy runs as (gateway-injection-template.yaml:38-39, waypoint.yaml:110-111).
    [
      'gateway chart pod, router role',
      withPods(OUTBOUND, CHART_GATEWAY),
      'istio-ingress/Deployment/istio-ingress#0',
      'depends',
      'depends: a gateway or waypoint forwards only what its routes name, and netatlas does not read them',
    ],
    [
      'waypoint by its role alone',
      withPods(OUTBOUND, ROLE_WAYPOINT),
      'shop/Deployment/mesh-waypoint#0',
      'depends',
      'depends: a gateway or waypoint forwards only what its routes name, and netatlas does not read them',
    ],
    [
      'router pod beside a sidecar pod, #1',
      CHART_ROLLOUT,
      'istio-ingress/Deployment/istio-ingress#1',
      'depends',
      'depends: a gateway or waypoint forwards only what its routes name, and netatlas does not read them',
    ],
    // A proxy run as sidecar keeps the outbound mode.
    ['sidecar role, recommender', withRecommender({ proxyRole: 'sidecar' }), recommender, 'any-domain', "any domain (ALLOW_ANY, Istio's default)"],
  ])('%s', (_name, r, id, kind, text) => {
    const layer = istioLayer(classOf(r, id), r);
    expect({ kind: layer.kind, text: layer.text }).toStrictEqual({ kind, text });
  });
});

/** A REGISTRY_ONLY mesh config, and a shop Sidecar without a selector that sets only egress hosts, the most common kind. */
const SHOP_HOSTS_ONLY = withSidecars(withMesh({ state: 'found', outbound: 'REGISTRY_ONLY' }), sidecar('shop', 'default', { egress: [{ hosts: ['./*'] }] }));

/** OUTBOUND with a second entry for api.partner.example, in shop, exported to every namespace. */
const WITH_PARTNER_MIRROR: ClusterResources = {
  ...OUTBOUND,
  serviceEntries: [
    ...(OUTBOUND.serviceEntries === 'not-installed' ? [] : OUTBOUND.serviceEntries),
    serviceEntry('shop', 'partner-mirror', { hosts: ['api.partner.example'], ports: [{ number: 443, name: 'tls', protocol: 'TLS' }], resolution: 'DNS' }),
  ],
};

/** OUTBOUND with an entry for fonts.example in shop, and a recommender Sidecar whose one egress host is `./*fonts.example`, a wildcard without its dot. */
const WITH_FONTS_APEX: ClusterResources = withSidecars(
  {
    ...OUTBOUND,
    serviceEntries: [
      ...(OUTBOUND.serviceEntries === 'not-installed' ? [] : OUTBOUND.serviceEntries),
      serviceEntry('shop', 'fonts-apex', { hosts: ['fonts.example'], ports: [{ number: 443, name: 'tls', protocol: 'TLS' }], resolution: 'DNS' }),
    ],
  },
  recommenderSidecar('recommender-fonts', [{ hosts: ['./*fonts.example'] }]),
);

const listed = (entry: string): Verdict => ({ outcome: 'allowed', text: `listed: REGISTRY_ONLY admits it (ServiceEntry ${entry})` });
const unlisted = (namespace: string): Verdict => ({ outcome: 'blocked', text: `blocked: REGISTRY_ONLY, and no ServiceEntry visible to ${namespace} lists it` });

describe('the Istio verdict for one host', () => {
  it.each<[string, ClusterResources, string, string | null, Verdict]>([
    ['api, api.partner.example', OUTBOUND, api, 'api.partner.example', listed('payments/partner')],
    // shop/fonts is exported to shop only.
    ['api, *.fonts.example', OUTBOUND, api, '*.fonts.example', unlisted('payments')],
    ['api, static.example', OUTBOUND, api, 'static.example', listed('shop/static')],
    // MESH_INTERNAL, exported to every namespace: REGISTRY_ONLY admits every host in the registry, whatever its location.
    ['api, ledger.internal', OUTBOUND, api, 'ledger.internal', listed('payments/internal')],
    ['api, no host', OUTBOUND, api, null, unlisted('payments')],
    ['cart, *.fonts.example', OUTBOUND, cart, '*.fonts.example', listed('shop/fonts')],
    ['cart, cdn.fonts.example', OUTBOUND, cart, 'cdn.fonts.example', listed('shop/fonts')],
    // Ends in fonts.example, but not in .fonts.example, so *.fonts.example does not cover it.
    ['cart, evilfonts.example', OUTBOUND, cart, 'evilfonts.example', unlisted('shop')],
    // A pattern that alone is a wildcard covers every host ending in what follows its `*`, with no length check (host/name.go:79-82).
    ['recommender, *fonts.example covers fonts.example', WITH_FONTS_APEX, recommender, 'fonts.example', listed('shop/fonts-apex')],
    ['cart, api.partner.example', OUTBOUND, cart, 'api.partner.example', listed('payments/partner')],
    // cart-registry with shop/api.partner.example for payments/api.partner.example: `./*` and `shop/` cover entries in shop only, and partner is in payments.
    [
      'cart, partner not imported',
      withSidecars(
        OUTBOUND,
        sidecar(
          'shop',
          'cart-registry',
          { workloadSelector: { labels: { app: 'cart' } }, outboundTrafficPolicy: {}, egress: [{ hosts: ['./*', 'shop/api.partner.example'] }] },
          '2026-11-02T00:00:00Z',
        ),
      ),
      cart,
      'api.partner.example',
      unlisted('shop'),
    ],
    ['recommender, anything.example', OUTBOUND, recommender, 'anything.example', { outcome: 'any', text: "any domain (ALLOW_ANY, Istio's default)" }],
    // shop/default sets no outboundTrafficPolicy, so the mesh's REGISTRY_ONLY applies, and its egress hosts still limit the entries: `./*` is shop's.
    ['shop/default hosts only, partner', SHOP_HOSTS_ONLY, recommender, 'api.partner.example', unlisted('shop')],
    ['shop/default hosts only, static', SHOP_HOSTS_ONLY, recommender, 'static.example', listed('shop/static')],
    // Two visible entries list one host: Istio keeps the one in the proxy's own namespace (sidecar.go:870-916).
    ['two entries for one host, cart', WITH_PARTNER_MIRROR, cart, 'api.partner.example', listed('shop/partner-mirror')],
    ['two entries for one host, api', WITH_PARTNER_MIRROR, api, 'api.partner.example', listed('payments/partner')],
    // payments/partner leaves exportTo empty, so it takes the mesh's default `.`: payments only.
    [
      'root REGISTRY_ONLY, partner',
      withSidecars(withMesh({ state: 'found', outbound: 'unset', defaultServiceExportTo: ['.'] }), rootRegistryOnly),
      recommender,
      'api.partner.example',
      unlisted('shop'),
    ],
    // shop/static takes the same default, and `.` is its own namespace, shop.
    [
      'root REGISTRY_ONLY, static',
      withSidecars(withMesh({ state: 'found', outbound: 'unset', defaultServiceExportTo: ['.'] }), rootRegistryOnly),
      recommender,
      'static.example',
      listed('shop/static'),
    ],
    [
      'frontend, cdn.fonts.example',
      OUTBOUND,
      frontend,
      'cdn.fonts.example',
      { outcome: 'depends', text: 'depends: the Sidecar shop/frontend-tilde lists egress hosts netatlas does not evaluate (~/*.fonts.example)' },
    ],
    ['gateway, api.partner.example', OUTBOUND, gateway, 'api.partner.example', { outcome: 'any', text: 'not in the mesh' }],
  ])('%s', (_name, r, id, host, expected) => {
    const c = classOf(r, id);
    expect(istioVerdict(istioLayer(c, r), host, c.namespace)).toStrictEqual(expected);
  });
});

const tcp443 = { number: 443, protocol: 'TCP' } as const;
/** The one target of payments/partner (DNS, so no address) and of shop/static (STATIC, one endpoint), each with one port; their own test pins both. */
const partnerTarget: NetpolTarget = { addresses: null, port: tcp443 };
const staticTarget: NetpolTarget = { addresses: ['203.0.113.10'], port: tcp443 };

/** recommender's egress restricted to UDP 53, to any address: DNS to anywhere. */
const RECOMMENDER_DNS_ONLY = withPolicies(
  OUTBOUND,
  networkPolicy('shop', 'recommender-dns', { podSelector: { matchLabels: { app: 'recommender' } }, policyTypes: ['Egress'], egress: [{ ports: [{ port: 53, protocol: 'UDP' }] }] }),
);

/** serviceEntryTargets of a STATIC entry whose two endpoints use different ports: no one port. */
const twoEndpointPorts: NetpolTarget = { addresses: ['198.51.100.7', '198.51.100.8'] };

/** A NONE entry's address range, 203.0.113.0/24, on TCP 443. */
const partnerRange: NetpolTarget = { addresses: ['203.0.113.0/24'], port: tcp443 };

/** api-partner with two blocks that between them cover 203.0.113.0/24, each only half of it. */
const API_SPLIT_RANGE = withPolicies(
  OUTBOUND,
  networkPolicy('payments', 'api-partner', {
    podSelector: { matchLabels: { app: 'api' } },
    policyTypes: ['Egress'],
    egress: [{ to: [{ ipBlock: { cidr: '203.0.113.0/25' } }, { ipBlock: { cidr: '203.0.113.128/25' } }], ports: [{ protocol: 'TCP', port: 443 }] }],
  }),
);

describe('the NetworkPolicy verdict', () => {
  it.each<[string, ClusterResources, string, NetpolTarget, Verdict]>([
    ['recommender, partner', OUTBOUND, recommender, partnerTarget, { outcome: 'any', text: 'any address: no NetworkPolicy restricts its egress' }],
    ['api, static', OUTBOUND, api, staticTarget, { outcome: 'allowed', text: 'allowed by api-partner (203.0.113.0/24 except 203.0.113.128/25)' }],
    // Inside the cidr, but inside its except.
    [
      'api, 203.0.113.200 on 443',
      OUTBOUND,
      api,
      { addresses: ['203.0.113.200'], port: tcp443 },
      { outcome: 'blocked', text: 'blocked by api-allow and api-partner: no egress rule admits 203.0.113.200' },
    ],
    // The block admits the address, but its rule opens TCP 443 only, so the text names the port.
    [
      'api, 203.0.113.10 on 80',
      OUTBOUND,
      api,
      { addresses: ['203.0.113.10'], port: { number: 80, protocol: 'TCP' } },
      { outcome: 'blocked', text: 'blocked by api-allow and api-partner: no egress rule admits 203.0.113.10 on TCP 80' },
    ],
    // Calls to 203.0.113.10 pass and calls to 203.0.113.200 do not, so it depends on which one is called.
    [
      'api, one of two addresses',
      OUTBOUND,
      api,
      { addresses: ['203.0.113.10', '203.0.113.200'], port: tcp443 },
      { outcome: 'depends', text: 'depends on which address it calls: no egress rule of api-allow and api-partner admits 203.0.113.200' },
    ],
    [
      'api, two refused addresses',
      OUTBOUND,
      api,
      { addresses: ['203.0.113.200', '203.0.113.129'], port: tcp443 },
      { outcome: 'blocked', text: 'blocked by api-allow and api-partner: no egress rule admits 203.0.113.200, 203.0.113.129' },
    ],
    [
      'api, two admitted addresses',
      OUTBOUND,
      api,
      { addresses: ['203.0.113.10', '203.0.113.20'], port: tcp443 },
      { outcome: 'allowed', text: 'allowed by api-partner (203.0.113.0/24 except 203.0.113.128/25)' },
    ],
    ['api, partner', OUTBOUND, api, partnerTarget, { outcome: 'depends', text: 'depends on the address the name resolves to (api-allow and api-partner)' }],
    ['cart, partner', OUTBOUND, cart, partnerTarget, { outcome: 'blocked', text: 'blocked: its egress admits no address outside the cluster (cart-allow)' }],
    [
      'recommender-out, partner',
      withPolicies(OUTBOUND, networkPolicy('shop', 'recommender-out', { podSelector: { matchLabels: { app: 'recommender' } }, egress: [{ ports: [{ port: 443 }] }] })),
      recommender,
      partnerTarget,
      { outcome: 'any', text: 'any address on TCP 443 (recommender-out)' },
    ],
    // DNS to any address: an address rule exists, but none opens the port in question.
    [
      'recommender DNS only, partner',
      RECOMMENDER_DNS_ONLY,
      recommender,
      partnerTarget,
      { outcome: 'blocked', text: 'blocked by recommender-dns: no egress rule admits TCP 443 to an address outside the cluster' },
    ],
    // No port: the peerless rule admits these addresses on UDP 53, and netatlas does not know which port is called.
    ['recommender DNS only, no port', RECOMMENDER_DNS_ONLY, recommender, twoEndpointPorts, { outcome: 'depends', text: 'depends on the port it calls (recommender-dns)' }],
    // No address known and no port: the peerless rule admits every address on UDP 53, so the call is not blocked; it depends on the port.
    ['recommender DNS, no address or port', RECOMMENDER_DNS_ONLY, recommender, { addresses: null }, { outcome: 'depends', text: 'depends on the port it calls (recommender-dns)' }],
    // No port, but the admitting rule names no ports, so it opens every port and the port does not matter.
    [
      'recommender every port, no port',
      withPolicies(OUTBOUND, networkPolicy('shop', 'recommender-all-out', { podSelector: { matchLabels: { app: 'recommender' } }, policyTypes: ['Egress'], egress: [{}] })),
      recommender,
      twoEndpointPorts,
      { outcome: 'any', text: 'any address on every port (recommender-all-out)' },
    ],
    // No port, and no rule admits either address on any port.
    ['cart, no port', OUTBOUND, cart, twoEndpointPorts, { outcome: 'blocked', text: 'blocked by cart-allow: no egress rule admits 198.51.100.7, 198.51.100.8' }],
    // api-partner admits the range's lower half only: calls to .0 to .127 pass, calls to .128 to .255 do not.
    ['api, a range one block admits in part', OUTBOUND, api, partnerRange, { outcome: 'depends', text: 'depends on which address of 203.0.113.0/24 it calls (api-allow and api-partner)' }],
    // Each block holds half of the range and neither holds all of it.
    ['api, a range two blocks split', API_SPLIT_RANGE, api, partnerRange, { outcome: 'depends', text: 'depends on which address of 203.0.113.0/24 it calls (api-allow and api-partner)' }],
  ])('%s', (_name, r, id, target, expected) => {
    expect(netpolVerdict(classOf(r, id), netpolEvaluator(r), target)).toStrictEqual(expected);
  });
});

const entryOf = (namespace: string, name: string): ServiceEntryObject => {
  const list = OUTBOUND.serviceEntries === 'not-installed' ? [] : OUTBOUND.serviceEntries;
  const se = list.find((x) => x.metadata.namespace === namespace && x.metadata.name === name);
  if (!se) throw new Error(`OUTBOUND has no ServiceEntry ${namespace}/${name}`);
  return se;
};

const https8443 = { number: 8443, name: 'https', protocol: 'HTTPS', targetPort: 8444 };

// The address and port the sidecar connects to for each port of the entry, which is what a NetworkPolicy
// sees leave the pod (serviceentry/conversion.go:213-239, 346-384): Istio serves every port of an entry
// (conversion.go:230-240). A port whose protocol is UDP runs over UDP, every other over TCP.
it.each<[string, ServiceEntryObject, NetpolTarget[]]>([
  ['payments/partner', entryOf('payments', 'partner'), [partnerTarget]],
  ['shop/static', entryOf('shop', 'static'), [staticTarget]],
  // NONE passes the call through to the address the app dialled.
  [
    'NONE',
    serviceEntry('payments', 'bank', { hosts: ['bank.example'], addresses: ['192.0.2.0/24'], ports: [{ number: 443, name: 'tls', protocol: 'TLS' }], resolution: 'NONE' }),
    [{ addresses: ['192.0.2.0/24'], port: tcp443 }],
  ],
  // Resolution unset is NONE, and its upstream port is targetPort too (conversion.go:231-239, cluster_builder.go:533-540).
  [
    'unset resolution',
    serviceEntry('shop', 'office', { hosts: ['office.example'], addresses: ['198.51.100.0/28'], ports: [{ number: 22, name: 'ssh', protocol: 'TCP', targetPort: 2222 }] }),
    [{ addresses: ['198.51.100.0/28'], port: { number: 2222, protocol: 'TCP' } }],
  ],
  // STATIC connects to its endpoints, never to the VIP in addresses; one target per port, in the entry's order.
  [
    'STATIC endpoints, not the VIP',
    serviceEntry('shop', 'mirror', {
      hosts: ['mirror.example'],
      addresses: ['192.0.2.10'],
      ports: [
        { number: 8443, name: 'https', protocol: 'HTTPS' },
        { number: 80, name: 'http', protocol: 'HTTP' },
      ],
      resolution: 'STATIC',
      endpoints: [{ address: '198.51.100.7' }, { address: '198.51.100.8' }],
    }),
    [
      { addresses: ['198.51.100.7', '198.51.100.8'], port: { number: 8443, protocol: 'TCP' } },
      { addresses: ['198.51.100.7', '198.51.100.8'], port: { number: 80, protocol: 'TCP' } },
    ],
  ],
  // The endpoint's own port for the port's name comes before targetPort.
  [
    'STATIC endpoint port',
    serviceEntry('shop', 'mirror', { hosts: ['mirror.example'], ports: [https8443], resolution: 'STATIC', endpoints: [{ address: '198.51.100.9', ports: { https: 9443 } }] }),
    [{ addresses: ['198.51.100.9'], port: { number: 9443, protocol: 'TCP' } }],
  ],
  [
    'STATIC targetPort',
    serviceEntry('shop', 'mirror', { hosts: ['mirror.example'], ports: [https8443], resolution: 'STATIC', endpoints: [{ address: '198.51.100.9' }] }),
    [{ addresses: ['198.51.100.9'], port: { number: 8444, protocol: 'TCP' } }],
  ],
  // No endpoints: the sidecar has nothing to connect to, whatever addresses says.
  [
    'STATIC without endpoints',
    serviceEntry('shop', 'mirror', { hosts: ['mirror.example'], addresses: ['192.0.2.10'], ports: [{ number: 443, name: 'tls', protocol: 'TLS' }], resolution: 'STATIC' }),
    [{ addresses: null, port: tcp443 }],
  ],
  // DNS connects to what the name resolves to, so addresses is a VIP no policy sees; the port is targetPort.
  [
    'DNS with addresses and targetPort',
    serviceEntry('payments', 'partner-vip', {
      hosts: ['api.partner.example'],
      addresses: ['192.0.2.20'],
      ports: [{ number: 443, name: 'tls', protocol: 'TLS', targetPort: 8443 }],
      resolution: 'DNS',
    }),
    [{ addresses: null, port: { number: 8443, protocol: 'TCP' } }],
  ],
  [
    'DNS_ROUND_ROBIN with addresses',
    serviceEntry('shop', 'cdn', { hosts: ['cdn.example'], addresses: ['192.0.2.30'], ports: [{ number: 80, name: 'http', protocol: 'HTTP' }], resolution: 'DNS_ROUND_ROBIN' }),
    [{ addresses: null, port: { number: 80, protocol: 'TCP' } }],
  ],
  // A DNS entry's endpoints are names to resolve, not addresses.
  [
    'DNS endpoints',
    serviceEntry('shop', 'mirror-dns', { hosts: ['mirror.example'], ports: [{ number: 443, name: 'tls', protocol: 'TLS' }], resolution: 'DNS', endpoints: [{ address: 'mirror-a.example' }] }),
    [partnerTarget],
  ],
  // Endpoints on 9443 and 9444 for one port name: the target has no one port.
  [
    'STATIC endpoints on two ports',
    serviceEntry('shop', 'mirror', {
      hosts: ['mirror.example'],
      ports: [{ number: 443, name: 'tls', protocol: 'TLS' }],
      resolution: 'STATIC',
      endpoints: [
        { address: '198.51.100.7', ports: { tls: 9443 } },
        { address: '198.51.100.8', ports: { tls: 9444 } },
      ],
    }),
    [twoEndpointPorts],
  ],
  // Istio accepts UDP (pkg/config/protocol/instance.go:48-50) and reads the protocol without regard to case (:68-73).
  [
    'a UDP port, written in lower case',
    serviceEntry('shop', 'ntp', { hosts: ['ntp.example'], ports: [{ number: 123, name: 'ntp', protocol: 'udp' }], resolution: 'DNS' }),
    [{ addresses: null, port: { number: 123, protocol: 'UDP' } }],
  ],
  // NONE passes the call through to the address dialled, on the port's transport too.
  [
    'NONE, a UDP port',
    serviceEntry('shop', 'syslog', { hosts: ['syslog.example'], addresses: ['192.0.2.40'], ports: [{ number: 514, name: 'syslog', protocol: 'UDP' }], resolution: 'NONE' }),
    [{ addresses: ['192.0.2.40'], port: { number: 514, protocol: 'UDP' } }],
  ],
])('serviceEntryTargets of %s', (_name, se, expected) => {
  expect(serviceEntryTargets(se)).toStrictEqual(expected);
});
