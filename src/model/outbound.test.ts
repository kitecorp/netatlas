import { describe, expect, it } from 'vitest';
import { callOut, OUTBOUND, OUTBOUND_TRAFFIC, serviceEntry } from './fixtures/outbound';
import { deployment, networkPolicy, SHOP, withPolicies } from './fixtures/shop';
import { AMBIENT, bytes, call, closed, EGRESS_GATEWAY, requests, withFigures } from './fixtures/traffic';
import { internetShortList, mayCallGroups, noDestinationText, outboundRows, searchOutboundRows, type DoCall, type MayCall, type MayCallGroup, type OutboundKind, type OutboundRow, type ShortList } from './outbound';
import type { TrafficSnapshot } from './traffic-status';
import type { ClusterResources, Labels } from './types';

const ANY_ADDRESS = 'any address: no NetworkPolicy restricts its egress';
const ALLOW_ANY_DEFAULT = "any domain (ALLOW_ANY, Istio's default)";
const CART_BLOCKED = 'blocked: its egress admits no address outside the cluster (cart-allow)';
const ANY_ROW = 'Any other address or domain';
const ANY_NOTE = 'What these workloads call is listed in the rows above.';
const NOT_IN_MESH = 'not in the mesh';
const RANGE = '203.0.113.0/24 except 203.0.113.128/25';
const UNREGISTERED = 'Unregistered TLS or TCP traffic';
const BLOCKED_EVIL = 'Blocked by REGISTRY_ONLY: evil.example';

const listed = (entry: string) => `listed: REGISTRY_ONLY admits it (ServiceEntry ${entry})`;

/** The rows of one destination: exactly one is expected, so a missing or doubled row shows in the diff. */
const rowsTo = (rows: readonly OutboundRow[], destination: string) => rows.filter((x) => x.destination === destination);

describe('the Outbound rows', () => {
  /** recommender's and postgres's TLS to the partner: one destination with two callers, which the short list sums. postgres has the higher rate. */
  const fromPostgres = callOut('payments/postgres', 'api.partner.example', 'api.partner.example');
  const fromRecommender = callOut('shop/recommender', 'api.partner.example', 'api.partner.example');
  const TWO_CALLERS: TrafficSnapshot = withFigures({
    requestBytes: [bytes(fromRecommender, 1000), bytes(fromPostgres, 1500)],
    responseBytes: [bytes(fromRecommender, 1000), bytes(fromPostgres, 1500)],
    closed: [closed(fromRecommender, '-', 0.1), closed(fromPostgres, '-', 0.2)],
  });

  const API_DEPENDS = 'depends on the address the name resolves to (api-allow and api-partner)';

  /** recommender's TLS to the partner, 1000 B/s each way and 0.1 closed connections a second. */
  const PARTNER_FROM_RECOMMENDER: OutboundRow = {
    kind: 'named',
    destination: 'api.partner.example',
    ports: 'TLS 443',
    mayCall: [
      { workload: 'shop / recommender', netpol: ANY_ADDRESS, istio: ALLOW_ANY_DEFAULT },
      { workload: 'payments / api', netpol: API_DEPENDS, istio: listed('payments/partner') },
      { workload: 'payments / postgres', netpol: ANY_ADDRESS, istio: listed('payments/partner') },
      { workload: 'shop / cart', netpol: CART_BLOCKED, istio: listed('payments/partner') },
    ],
    // coredns; frontend and gateway are blocked by their NetworkPolicies.
    othersMay: 1,
    doCall: [{ workload: 'shop / recommender', text: '2 kB/s', rate: 0.1, requests: 0, bytes: 2000 }],
  };

  /**
   * The same call in the form Istio reports it: the partner is a DNS entry without endpoints, so its one
   * endpoint is named by the entry, payments/partner, and that is the destination workload
   * (pilot/pkg/serviceregistry/serviceentry/conversion.go:363-379).
   */
  const toPartnerAsIstioNamesIt = call('source', 'shop/recommender', 'payments/partner', { destination_service: 'api.partner.example', destination_service_name: 'api.partner.example' });

  /** A DNS entry for NTP on UDP 123, exported to every namespace: Istio accepts UDP as a ServiceEntry port's protocol (pkg/config/protocol/instance.go:48-50). */
  const NTP = serviceEntry('shop', 'ntp', { hosts: ['ntp.example'], ports: [{ number: 123, name: 'ntp', protocol: 'UDP' }], resolution: 'DNS' });

  /** A rule that lets the selected pods reach every address on port 123 of one protocol. */
  const port123Out = (protocol: 'TCP' | 'UDP', namespace: string, name: string, matchLabels: Labels) =>
    networkPolicy(namespace, name, { podSelector: { matchLabels }, policyTypes: ['Egress'], egress: [{ to: [{ ipBlock: { cidr: '0.0.0.0/0' } }], ports: [{ protocol, port: 123 }] }] });

  /**
   * OUTBOUND with NTP, and rules on port 123 of `protocol` for coredns (no sidecar: judged on the entry's
   * own port), recommender and api (sidecars: judged on what the sidecar connects to).
   */
  const withNtp = (protocol: 'TCP' | 'UDP'): ClusterResources => ({
    ...withPolicies(
      OUTBOUND,
      port123Out(protocol, 'kube-system', 'coredns-ntp', { 'k8s-app': 'kube-dns' }),
      port123Out(protocol, 'shop', 'recommender-ntp', { app: 'recommender' }),
      port123Out(protocol, 'payments', 'api-ntp', { app: 'api' }),
    ),
    serviceEntries: [...(OUTBOUND.serviceEntries === 'not-installed' ? [] : OUTBOUND.serviceEntries), NTP],
  });

  const OUTBOUND_ENTRIES = OUTBOUND.serviceEntries === 'not-installed' ? [] : OUTBOUND.serviceEntries;
  const tls443 = [{ number: 443, name: 'tls', protocol: 'TLS' }];
  /** A rule with no peers that lets the selected pods reach every address on one TCP port only. */
  const peerlessOn = (port: number, namespace: string, name: string, matchLabels: Labels) =>
    networkPolicy(namespace, name, { podSelector: { matchLabels }, policyTypes: ['Egress'], egress: [{ ports: [{ protocol: 'TCP', port }] }] });

  /** OUTBOUND's entries with the partner's, a DNS entry, serving `ports` instead of TLS 443 alone. */
  const partnerOn = (...ports: { number: number; name: string; protocol: string }[]) =>
    OUTBOUND_ENTRIES.map((se) => (se.metadata.name === 'partner' ? serviceEntry('payments', 'partner', { hosts: ['api.partner.example'], ports, resolution: 'DNS' }) : se));
  const http80 = { number: 80, name: 'http', protocol: 'HTTP' };

  /**
   * OUTBOUND with the partner's entry serving HTTP 80 and TLS 443, and rules with no peers that open TCP 443
   * only: for api, a sidecar, judged on what its sidecar connects to, and for coredns, judged on the port it dials.
   */
  const PARTNER_TWO_PORTS: ClusterResources = {
    ...withPolicies(OUTBOUND, peerlessOn(443, 'payments', 'api-out-443', { app: 'api' }), peerlessOn(443, 'kube-system', 'coredns-out-443', { 'k8s-app': 'kube-dns' })),
    serviceEntries: partnerOn(http80, ...tls443),
  };

  /**
   * OUTBOUND with the partner's entry serving HTTP 80, TLS 443 and TLS 8443, and a rule with no peers that lets postgres
   * reach every address on TCP 8443 alone: postgres is blocked on 80 and 443, and open on 8443.
   */
  const PARTNER_THREE_PORTS: ClusterResources = {
    ...withPolicies(OUTBOUND, peerlessOn(8443, 'payments', 'postgres-out-8443', { app: 'postgres' })),
    serviceEntries: partnerOn(http80, ...tls443, { number: 8443, name: 'tls-alt', protocol: 'TLS' }),
  };

  /** A rule with no peers that lets the selected pods resolve names, on UDP and TCP 53, and reach nothing else outside the cluster. */
  const dnsOnly = (namespace: string, name: string, matchLabels: Labels) =>
    networkPolicy(namespace, name, {
      podSelector: { matchLabels },
      policyTypes: ['Egress'],
      egress: [
        {
          ports: [
            { protocol: 'UDP', port: 53 },
            { protocol: 'TCP', port: 53 },
          ],
        },
      ],
    });

  /** PARTNER_TWO_PORTS with the egress of postgres (listed by REGISTRY_ONLY) and of recommender (counted) limited to DNS. */
  const PARTNER_TWO_PORTS_DNS_ONLY = withPolicies(PARTNER_TWO_PORTS, dnsOnly('payments', 'postgres-dns', { app: 'postgres' }), dnsOnly('shop', 'recommender-dns', { app: 'recommender' }));

  /** A rule that lets recommender reach 198.51.100.0/24 on one TCP port. */
  const recommenderOn = (port: number) =>
    networkPolicy('shop', `recommender-${port}`, {
      podSelector: { matchLabels: { app: 'recommender' } },
      policyTypes: ['Egress'],
      egress: [{ to: [{ ipBlock: { cidr: '198.51.100.0/24' } }], ports: [{ protocol: 'TCP', port }] }],
    });

  /**
   * OUTBOUND with shop/mirror, a STATIC entry whose endpoint 198.51.100.7 serves HTTP 80 and TLS 443, exported to
   * every namespace, and a rule of its own for each port for recommender: recommender-80 and recommender-443.
   */
  const MIRROR_RULE_PER_PORT: ClusterResources = {
    ...withPolicies(OUTBOUND, recommenderOn(80), recommenderOn(443)),
    serviceEntries: [
      ...OUTBOUND_ENTRIES,
      serviceEntry('shop', 'mirror', {
        hosts: ['mirror.example'],
        ports: [
          { number: 80, name: 'http', protocol: 'HTTP' },
          { number: 443, name: 'tls', protocol: 'TLS' },
        ],
        resolution: 'STATIC',
        endpoints: [{ address: '198.51.100.7' }],
      }),
    ],
  };

  /**
   * Two STATIC entries for db.partner.example, neither in shop: billing/db-private, exported to billing only,
   * with its endpoint at 198.51.100.7, and payments/db-public, exported to every namespace, with its endpoint at
   * 203.0.113.10. billing sorts first. cart-out lets cart reach 203.0.113.0/24 on TCP 443.
   */
  const DB_TWO_ENTRIES: ClusterResources = {
    ...withPolicies(
      OUTBOUND,
      networkPolicy('shop', 'cart-out', { podSelector: { matchLabels: { app: 'cart' } }, policyTypes: ['Egress'], egress: [{ to: [{ ipBlock: { cidr: '203.0.113.0/24' } }], ports: [{ protocol: 'TCP', port: 443 }] }] }),
    ),
    serviceEntries: [
      ...OUTBOUND_ENTRIES,
      serviceEntry('billing', 'db-private', { hosts: ['db.partner.example'], exportTo: ['.'], ports: tls443, resolution: 'STATIC', endpoints: [{ address: '198.51.100.7' }] }),
      serviceEntry('payments', 'db-public', { hosts: ['db.partner.example'], ports: tls443, resolution: 'STATIC', endpoints: [{ address: '203.0.113.10' }] }),
    ],
  };

  /** OUTBOUND as the reader gives it when the role may not list NetworkPolicies: none of them, and the kind in readErrors. */
  const NETWORK_POLICIES_UNREADABLE: ClusterResources = { ...OUTBOUND, networkPolicies: [], readErrors: [{ kind: 'networkpolicies', reason: 'forbidden' }] };
  const NETWORK_POLICIES_DEPEND = "depends: netatlas's role may not read NetworkPolicies";

  /** recommender's HTTP to the partner, the Host header in other letter case: a host name matches whatever its case. */
  const toPartnerInCapitals = requests(callOut('shop/recommender', 'API.Partner.Example', 'API.Partner.Example'), '200', '-', 1);

  /** NTP's row, which nobody calls: REGISTRY_ONLY lists the entry for api, postgres and cart, so they are listed by workload id. */
  const ntpRow = (apiNetpol: string, othersMay: number): OutboundRow => ({
    kind: 'named',
    destination: 'ntp.example',
    ports: 'UDP 123',
    mayCall: [
      { workload: 'payments / api', netpol: apiNetpol, istio: listed('shop/ntp') },
      { workload: 'payments / postgres', netpol: ANY_ADDRESS, istio: listed('shop/ntp') },
      { workload: 'shop / cart', netpol: CART_BLOCKED, istio: listed('shop/ntp') },
    ],
    othersMay,
    doCall: [],
  });

  // The callers come first, in doCall's order: by rate, highest first, then by workload. The others follow by workload id.
  it.each<[string, ClusterResources, TrafficSnapshot | undefined, OutboundRow]>([
    ['OUTBOUND_TRAFFIC', OUTBOUND, OUTBOUND_TRAFFIC, PARTNER_FROM_RECOMMENDER],
    [
      'the call named by the endpoint Istio gives the entry',
      OUTBOUND,
      withFigures({
        requestBytes: [bytes(toPartnerAsIstioNamesIt, 1000)],
        responseBytes: [bytes(toPartnerAsIstioNamesIt, 1000)],
        closed: [closed(toPartnerAsIstioNamesIt, '-', 0.1)],
      }),
      PARTNER_FROM_RECOMMENDER,
    ],
    // api's and postgres's REGISTRY_ONLY lists ledger.internal (payments/internal), yet a seen row lists its
    // callers only: api, postgres and coredns are counted; frontend, gateway and cart are blocked.
    [
      'a MESH_INTERNAL host, a seen row',
      OUTBOUND,
      withFigures({ requests: [requests(callOut('shop/recommender', 'ledger.internal', 'ledger.internal'), '200', '-', 1)] }),
      {
        kind: 'seen',
        destination: 'ledger.internal',
        ports: '',
        mayCall: [{ workload: 'shop / recommender', netpol: ANY_ADDRESS, istio: ALLOW_ANY_DEFAULT }],
        othersMay: 3,
        doCall: [{ workload: 'shop / recommender', text: '1 req/s', rate: 1, requests: 1, bytes: 0 }],
      },
    ],
    // postgres (0.2 closed connections a second) before recommender (0.1), though recommender's workload text sorts first.
    [
      'two callers of one host',
      OUTBOUND,
      TWO_CALLERS,
      {
        kind: 'named',
        destination: 'api.partner.example',
        ports: 'TLS 443',
        mayCall: [
          { workload: 'payments / postgres', netpol: ANY_ADDRESS, istio: listed('payments/partner') },
          { workload: 'shop / recommender', netpol: ANY_ADDRESS, istio: ALLOW_ANY_DEFAULT },
          { workload: 'payments / api', netpol: API_DEPENDS, istio: listed('payments/partner') },
          { workload: 'shop / cart', netpol: CART_BLOCKED, istio: listed('payments/partner') },
        ],
        othersMay: 1,
        doCall: [
          { workload: 'payments / postgres', text: '3 kB/s', rate: 0.2, requests: 0, bytes: 3000 },
          { workload: 'shop / recommender', text: '2 kB/s', rate: 0.1, requests: 0, bytes: 2000 },
        ],
      },
    ],
    // The port's protocol is UDP, so the calls are judged on UDP 123. coredns-ntp and recommender-ntp admit
    // it, so coredns and recommender depend on the address ntp.example resolves to and are counted;
    // frontend and gateway are blocked by their NetworkPolicies. api-ntp admits it too, which api's line shows.
    ['a UDP entry, rules that admit UDP 123', withNtp('UDP'), undefined, ntpRow('depends on the address the name resolves to (api-allow, api-ntp and api-partner)', 2)],
    // Rules written for TCP 123 admit no UDP call: coredns and recommender are blocked, so not counted.
    [
      'a UDP entry, rules that admit TCP 123 only',
      withNtp('TCP'),
      undefined,
      ntpRow('blocked by api-allow, api-ntp and api-partner: no egress rule admits UDP 123 to an address outside the cluster', 0),
    ],
    // Each port of the entry is judged: TCP 443 is open to any address, TCP 80 to none. coredns, whose rule
    // opens 443 too, is counted with recommender; frontend and gateway are blocked on both ports.
    [
      'an entry with two ports, a rule that opens one of them',
      PARTNER_TWO_PORTS,
      undefined,
      {
        kind: 'named',
        destination: 'api.partner.example',
        ports: 'HTTP 80, TLS 443',
        mayCall: [
          { workload: 'payments / api', netpol: 'depends on the port it calls (api-allow, api-out-443 and api-partner)', istio: listed('payments/partner') },
          { workload: 'payments / postgres', netpol: ANY_ADDRESS, istio: listed('payments/partner') },
          { workload: 'shop / cart', netpol: CART_BLOCKED, istio: listed('payments/partner') },
        ],
        othersMay: 2,
        doCall: [],
      },
    ],
    // Both ports are blocked for postgres and for recommender, each with a text that names its port: the verdict is
    // blocked, with the two texts in the entry's order. postgres stays listed; recommender is no longer counted, so
    // coredns alone is.
    [
      'an entry with two ports, both blocked by a rule that admits DNS alone',
      PARTNER_TWO_PORTS_DNS_ONLY,
      undefined,
      {
        kind: 'named',
        destination: 'api.partner.example',
        ports: 'HTTP 80, TLS 443',
        mayCall: [
          { workload: 'payments / api', netpol: 'depends on the port it calls (api-allow, api-out-443 and api-partner)', istio: listed('payments/partner') },
          {
            workload: 'payments / postgres',
            netpol: 'blocked by postgres-dns: no egress rule admits TCP 80 to an address outside the cluster and blocked by postgres-dns: no egress rule admits TCP 443 to an address outside the cluster',
            istio: listed('payments/partner'),
          },
          { workload: 'shop / cart', netpol: CART_BLOCKED, istio: listed('payments/partner') },
        ],
        othersMay: 1,
        doCall: [],
      },
    ],
    // Each port is allowed for recommender by a rule of its own: the verdict is allowed, with the two texts in the
    // entry's order, so recommender is listed and no longer counted; coredns alone is.
    [
      'an entry with two ports, each allowed by a rule of its own',
      MIRROR_RULE_PER_PORT,
      undefined,
      {
        kind: 'named',
        destination: 'mirror.example',
        ports: 'HTTP 80, TLS 443',
        mayCall: [
          { workload: 'payments / api', netpol: 'blocked by api-allow and api-partner: no egress rule admits 198.51.100.7', istio: listed('shop/mirror') },
          { workload: 'payments / postgres', netpol: ANY_ADDRESS, istio: listed('shop/mirror') },
          { workload: 'shop / cart', netpol: 'blocked by cart-allow: no egress rule admits 198.51.100.7', istio: listed('shop/mirror') },
          { workload: 'shop / recommender', netpol: 'allowed by recommender-80 (198.51.100.0/24) and allowed by recommender-443 (198.51.100.0/24)', istio: ALLOW_ANY_DEFAULT },
        ],
        othersMay: 1,
        doCall: [],
      },
    ],
    // postgres is blocked on two ports and open on the third, so its line depends on the port: two blocked ports
    // alike do not make the entry blocked. api too reads blocked, depends and blocked. recommender and coredns are counted.
    [
      'an entry with three ports, blocked on two and open on the third',
      PARTNER_THREE_PORTS,
      undefined,
      {
        kind: 'named',
        destination: 'api.partner.example',
        ports: 'HTTP 80, TLS 443, TLS 8443',
        mayCall: [
          { workload: 'payments / api', netpol: 'depends on the port it calls (api-allow and api-partner)', istio: listed('payments/partner') },
          { workload: 'payments / postgres', netpol: 'depends on the port it calls (postgres-out-8443)', istio: listed('payments/partner') },
          { workload: 'shop / cart', netpol: CART_BLOCKED, istio: listed('payments/partner') },
        ],
        othersMay: 2,
        doCall: [],
      },
    ],
    // shop sees only payments/db-public, so cart's NetworkPolicy line is judged on its endpoint, which cart-out
    // admits, not on billing/db-private's, which sorts first; Istio lists neither for cart.
    [
      'two entries for one host, the one the caller sees',
      DB_TWO_ENTRIES,
      undefined,
      {
        kind: 'named',
        destination: 'db.partner.example',
        ports: 'TLS 443',
        mayCall: [
          { workload: 'payments / api', netpol: `allowed by api-partner (${RANGE})`, istio: listed('payments/db-public') },
          { workload: 'payments / postgres', netpol: ANY_ADDRESS, istio: listed('payments/db-public') },
          { workload: 'shop / cart', netpol: 'allowed by cart-out (203.0.113.0/24)', istio: 'blocked: REGISTRY_ONLY, and no ServiceEntry visible to shop lists it' },
        ],
        othersMay: 2,
        doCall: [],
      },
    ],
    // A NetworkPolicy netatlas may not read could restrict any workload: frontend, gateway, recommender and coredns are counted.
    [
      'NetworkPolicies unreadable',
      NETWORK_POLICIES_UNREADABLE,
      undefined,
      {
        kind: 'named',
        destination: 'api.partner.example',
        ports: 'TLS 443',
        mayCall: [
          { workload: 'payments / api', netpol: NETWORK_POLICIES_DEPEND, istio: listed('payments/partner') },
          { workload: 'payments / postgres', netpol: NETWORK_POLICIES_DEPEND, istio: listed('payments/partner') },
          { workload: 'shop / cart', netpol: NETWORK_POLICIES_DEPEND, istio: listed('payments/partner') },
        ],
        othersMay: 4,
        doCall: [],
      },
    ],
    ['the host in other letter case', OUTBOUND, withFigures({ requests: [toPartnerInCapitals] }), { ...PARTNER_FROM_RECOMMENDER, doCall: [{ workload: 'shop / recommender', text: '1 req/s', rate: 1, requests: 1, bytes: 0 }] }],
  ])('a ServiceEntry host lists who calls it and who may: %s', (_name, r, t, expected) => {
    expect(rowsTo(outboundRows(r, t), expected.destination)).toStrictEqual([expected]);
  });

  const PAYMENTS_REGISTRY_ONLY = 'only the hosts listed (REGISTRY_ONLY, Sidecar payments/registry-only)';
  /** HTTP to evil.example, which REGISTRY_ONLY refused. */
  const toEvil = (from: string, perSecond: number) => requests(callOut(from, 'evil.example', 'BlackHoleCluster'), '502', '-', perSecond);
  /** api's and postgres's HTTP to evil.example, both refused: 0.2 and 0.5 requests a second. */
  const TWO_REFUSED = withFigures({ requests: [toEvil('payments/postgres', 0.5), toEvil('payments/api', 0.2)] });
  /** recommender's one egress rule names no peers: it may reach every address, on TCP 443 only. */
  const RECOMMENDER_PEERLESS = withPolicies(
    OUTBOUND,
    networkPolicy('shop', 'recommender-out', { podSelector: { matchLabels: { app: 'recommender' } }, policyTypes: ['Egress'], egress: [{ ports: [{ protocol: 'TCP', port: 443 }] }] }),
  );

  /**
   * OUTBOUND with kube-proxy, a DaemonSet in kube-system as kind runs it, outside the mesh. Its workload id,
   * kube-system/DaemonSet/kube-proxy, sorts before coredns's kube-system/Deployment/coredns; its text,
   * kube-system / kube-proxy, sorts after coredns's.
   */
  const WITH_KUBE_PROXY: ClusterResources = {
    ...OUTBOUND,
    pods: [...OUTBOUND.pods, ...deployment('kube-system', 'kube-proxy', ['kube-proxy-x7k2p'], []).map((p) => ({ ...p, workload: { kind: 'DaemonSet', name: 'kube-proxy' } }))],
  };

  const RANGE_NOTE = 'Istio records no address, so calls to this range are not counted here.';

  /** OUTBOUND's one address range: api-partner admits it on TCP 443, which api's line names as its own ports. */
  const API_RANGE: OutboundRow = {
    kind: 'address-range',
    destination: RANGE,
    ports: 'TCP 443',
    mayCall: [{ workload: 'payments / api', netpol: `allowed by api-partner (${RANGE}) on TCP 443`, istio: PAYMENTS_REGISTRY_ONLY }],
    othersMay: 0,
    doCall: [],
    note: RANGE_NOTE,
  };

  it.each<[string, ClusterResources, TrafficSnapshot | undefined, OutboundKind, OutboundRow[]]>([
    [
      'unregistered TLS or TCP',
      OUTBOUND,
      OUTBOUND_TRAFFIC,
      'unregistered',
      [
        {
          kind: 'unregistered',
          destination: UNREGISTERED,
          ports: '',
          mayCall: [{ workload: 'shop / recommender', netpol: ANY_ADDRESS, istio: ALLOW_ANY_DEFAULT }],
          othersMay: 0,
          doCall: [{ workload: 'shop / recommender', text: '500 B/s', rate: 0, requests: 0, bytes: 500 }],
          note: 'Istio keeps no host, SNI or IP for these calls, so netatlas cannot name the destination.',
        },
      ],
    ],
    // One row per caller, by caller: api's 0.2 requests a second come before postgres's 0.5. A caller's line
    // is its Istio layer, as no host is known.
    [
      'blocked by REGISTRY_ONLY, two callers',
      OUTBOUND,
      TWO_REFUSED,
      'blocked',
      [
        {
          kind: 'blocked',
          destination: BLOCKED_EVIL,
          ports: '',
          mayCall: [{ workload: 'payments / api', netpol: API_DEPENDS, istio: PAYMENTS_REGISTRY_ONLY }],
          othersMay: 0,
          doCall: [{ workload: 'payments / api', text: '0.2 req/s', rate: 0.2, requests: 0.2, bytes: 0 }],
          note: 'Istio refused these calls: the host is not registered.',
        },
        {
          kind: 'blocked',
          destination: BLOCKED_EVIL,
          ports: '',
          mayCall: [{ workload: 'payments / postgres', netpol: ANY_ADDRESS, istio: PAYMENTS_REGISTRY_ONLY }],
          othersMay: 0,
          doCall: [{ workload: 'payments / postgres', text: '0.5 req/s', rate: 0.5, requests: 0.5, bytes: 0 }],
          note: 'Istio refused these calls: the host is not registered.',
        },
      ],
    ],
    [
      'unattributed',
      AMBIENT.resources,
      AMBIENT.traffic,
      'unattributed',
      [
        {
          kind: 'unattributed',
          destination: 'Unattributed traffic',
          ports: '',
          mayCall: [{ workload: 'shop / recommender', netpol: ANY_ADDRESS, istio: 'any domain: ztunnel passes unknown traffic through' }],
          othersMay: 0,
          doCall: [{ workload: 'shop / recommender', text: '1 kB/s', rate: 0, requests: 0, bytes: 1000 }],
          note: 'ztunnel recorded no destination for these calls.',
        },
      ],
    ],
    [
      'through an egress gateway',
      EGRESS_GATEWAY.resources,
      EGRESS_GATEWAY.traffic,
      'egress-gateway',
      [
        {
          kind: 'egress-gateway',
          destination: 'Through the egress gateway istio-system / istio-egressgateway',
          ports: '',
          mayCall: [{ workload: 'shop / cart', netpol: CART_BLOCKED, istio: ALLOW_ANY_DEFAULT }],
          othersMay: 0,
          doCall: [{ workload: 'shop / cart', text: '2 req/s', rate: 2, requests: 2, bytes: 0 }],
          note: "Istio splits this link in two: the gateway's own calls are listed under their hosts.",
        },
      ],
    ],
    // api-partner admits the range on TCP 443: the ports read as a named row's do.
    ['an address range', OUTBOUND, undefined, 'address-range', [API_RANGE]],
    // recommender-range names no ports, so it opens every port to its range, which sorts before api's by text.
    [
      'an address range, a rule that names no ports',
      withPolicies(
        OUTBOUND,
        networkPolicy('shop', 'recommender-range', { podSelector: { matchLabels: { app: 'recommender' } }, policyTypes: ['Egress'], egress: [{ to: [{ ipBlock: { cidr: '198.51.100.0/24' } }] }] }),
      ),
      undefined,
      'address-range',
      [
        {
          kind: 'address-range',
          destination: '198.51.100.0/24',
          ports: 'every port',
          mayCall: [{ workload: 'shop / recommender', netpol: 'allowed by recommender-range (198.51.100.0/24) on every port', istio: ALLOW_ANY_DEFAULT }],
          othersMay: 0,
          doCall: [],
          note: RANGE_NOTE,
        },
        API_RANGE,
      ],
    ],
    // The Ports cell is the union of what the rules open, and each workload's line names the ports its own
    // rules open, so frontend does not read as reaching every address on TCP 123.
    [
      'an address range two workloads name on different ports',
      withPolicies(OUTBOUND, port123Out('TCP', 'shop', 'cart-world', { app: 'cart' }), port123Out('UDP', 'shop', 'frontend-world', { app: 'frontend' })),
      undefined,
      'address-range',
      [
        {
          kind: 'address-range',
          destination: '0.0.0.0/0',
          ports: 'TCP 123, UDP 123',
          mayCall: [
            { workload: 'shop / cart', netpol: 'allowed by cart-world (0.0.0.0/0) on TCP 123', istio: 'only the hosts listed (REGISTRY_ONLY, Sidecar shop/cart-registry)' },
            {
              workload: 'shop / frontend',
              netpol: 'allowed by frontend-world (0.0.0.0/0) on UDP 123',
              istio: 'depends: the Sidecar shop/frontend-tilde lists egress hosts netatlas does not evaluate (~/*.fonts.example)',
            },
          ],
          othersMay: 0,
          doCall: [],
          note: RANGE_NOTE,
        },
        API_RANGE,
      ],
    ],
    // One row for the cluster: recommender is on it through a rule without peers, and it names no ports.
    [
      'any address, through a rule without peers',
      RECOMMENDER_PEERLESS,
      undefined,
      'any',
      [
        {
          kind: 'any',
          destination: ANY_ROW,
          ports: '',
          mayCall: [
            { workload: 'kube-system / coredns', netpol: ANY_ADDRESS, istio: NOT_IN_MESH },
            { workload: 'shop / recommender', netpol: 'depends on the port it calls (recommender-out)', istio: ALLOW_ANY_DEFAULT },
          ],
          othersMay: 0,
          doCall: [],
          note: ANY_NOTE,
        },
      ],
    ],
    // The workloads by their text, not by their id: kube-proxy's id sorts first, its text after coredns's.
    [
      'any address, by workload text',
      WITH_KUBE_PROXY,
      undefined,
      'any',
      [
        {
          kind: 'any',
          destination: ANY_ROW,
          ports: '',
          mayCall: [
            { workload: 'kube-system / coredns', netpol: ANY_ADDRESS, istio: NOT_IN_MESH },
            { workload: 'kube-system / kube-proxy', netpol: ANY_ADDRESS, istio: NOT_IN_MESH },
            { workload: 'shop / recommender', netpol: ANY_ADDRESS, istio: ALLOW_ANY_DEFAULT },
          ],
          othersMay: 0,
          doCall: [],
          note: ANY_NOTE,
        },
      ],
    ],
  ])('the rows of a kind with no host to judge, whole: %s', (_name, r, t, kind, expected) => {
    expect(outboundRows(r, t).filter((x) => x.kind === kind)).toStrictEqual(expected);
  });

  /** A NetworkPolicy that lets the selected pods reach 203.0.113.0/24, where static.example's one endpoint is, on that TCP port. */
  const toStaticRange = (namespace: string, name: string, matchLabels: Labels, port = 443) =>
    networkPolicy(namespace, name, {
      podSelector: { matchLabels },
      policyTypes: ['Egress'],
      egress: [{ to: [{ ipBlock: { cidr: '203.0.113.0/24' } }], ports: [{ protocol: 'TCP', port }] }],
    });

  /** Who may call static.example in OUTBOUND, by workload id: none of them calls it. */
  const staticMayCall: MayCall[] = [
    { workload: 'payments / api', netpol: `allowed by api-partner (${RANGE})`, istio: listed('shop/static') },
    { workload: 'payments / postgres', netpol: ANY_ADDRESS, istio: listed('shop/static') },
    { workload: 'shop / cart', netpol: 'blocked by cart-allow: no egress rule admits 203.0.113.10', istio: listed('shop/static') },
  ];

  const staticRow = (mayCall: MayCall[], othersMay: number): OutboundRow => ({ kind: 'named', destination: 'static.example', ports: 'TLS 443', mayCall, othersMay, doCall: [] });

  // Task 7's ruling: a workload without a sidecar dials what the name resolves to, so the entry's endpoint
  // decides nothing for it, and its verdict reads { addresses: null } with the port.
  it.each<[string, ClusterResources, OutboundRow]>([
    // coredns-out admits 203.0.113.10, but coredns may not reach it: the verdict depends, and coredns is
    // counted under othersMay with recommender, not listed.
    ['coredns, no sidecar', withPolicies(OUTBOUND, toStaticRange('kube-system', 'coredns-out', { 'k8s-app': 'kube-dns' })), staticRow(staticMayCall, 2)],
    // coredns-out admits the range on TCP 8443 only, and coredns dials the entry's own port, 443: blocked, so not counted.
    ['coredns, no sidecar, the range admitted on another port', withPolicies(OUTBOUND, toStaticRange('kube-system', 'coredns-out', { 'k8s-app': 'kube-dns' }, 8443)), staticRow(staticMayCall, 1)],
    // The control: recommender's sidecar connects to the entry's endpoint, which recommender-out admits.
    [
      'recommender, a sidecar',
      withPolicies(OUTBOUND, toStaticRange('shop', 'recommender-out', { app: 'recommender' })),
      staticRow([...staticMayCall, { workload: 'shop / recommender', netpol: 'allowed by recommender-out (203.0.113.0/24)', istio: ALLOW_ANY_DEFAULT }], 1),
    ],
  ])('a workload without a sidecar is judged on the address its name resolves to: %s', (_name, r, expected) => {
    expect(rowsTo(outboundRows(r, undefined), 'static.example')).toStrictEqual([expected]);
  });

  type Listed = readonly [OutboundKind, string] | readonly [OutboundKind, string, readonly string[]];

  /** The one `any` row of a cluster is listed with its workloads. */
  const anyRow = (...workloads: string[]): Listed => ['any', ANY_ROW, workloads];

  it.each<[string, ClusterResources, TrafficSnapshot | undefined, Listed[]]>([
    [
      'OUTBOUND with traffic',
      OUTBOUND,
      OUTBOUND_TRAFFIC,
      [
        ['seen', 'cdn.example'],
        ['named', 'api.partner.example'],
        ['named', '*.fonts.example'],
        ['named', 'static.example'],
        ['blocked', BLOCKED_EVIL],
        ['unregistered', UNREGISTERED],
        ['address-range', RANGE],
        anyRow('kube-system / coredns', 'shop / recommender'),
      ],
    ],
    [
      'OUTBOUND without traffic',
      OUTBOUND,
      undefined,
      [
        ['named', '*.fonts.example'],
        ['named', 'api.partner.example'],
        ['named', 'static.example'],
        ['address-range', RANGE],
        anyRow('kube-system / coredns', 'shop / recommender'),
      ],
    ],
    // The gateway's own call is listed under its host. The gateway is not on the `any` row: Task 7's ruling
    // gives it its own Istio layer (depends), which is neither any domain nor outside the mesh.
    [
      'an egress gateway',
      EGRESS_GATEWAY.resources,
      EGRESS_GATEWAY.traffic,
      [
        ['seen', 'api.partner.example'],
        ['egress-gateway', 'Through the egress gateway istio-system / istio-egressgateway'],
        anyRow('kube-system / coredns', 'payments / postgres', 'shop / recommender'),
      ],
    ],
    ['ambient, ztunnel names no destination', AMBIENT.resources, AMBIENT.traffic, [['unattributed', 'Unattributed traffic'], anyRow('kube-system / coredns', 'payments / postgres', 'shop / recommender')]],
    // No workload is said to reach any address while the NetworkPolicies that might restrict it cannot be read.
    [
      'NetworkPolicies unreadable',
      NETWORK_POLICIES_UNREADABLE,
      undefined,
      [
        ['named', '*.fonts.example'],
        ['named', 'api.partner.example'],
        ['named', 'static.example'],
      ],
    ],
    // A workload netatlas does not see, in another cluster: after the per-caller rows, before the address ranges.
    [
      'a call into another cluster of the mesh',
      OUTBOUND,
      withFigures({ requests: [requests(call('source', 'shop/recommender', 'payments/ledger', { destination_cluster: 'east' }), '200', '-', 1)] }),
      [
        ['named', '*.fonts.example'],
        ['named', 'api.partner.example'],
        ['named', 'static.example'],
        ['mesh-cluster', 'Another cluster of the mesh (east)'],
        ['address-range', RANGE],
        anyRow('kube-system / coredns', 'shop / recommender'),
      ],
    ],
  ])('the rows in order: %s', (_name, r, t, expected) => {
    expect(outboundRows(r, t).map((x): Listed => (x.kind === 'any' ? [x.kind, x.destination, x.mayCall.map((m) => m.workload)] : [x.kind, x.destination]))).toStrictEqual(expected);
  });

  /** A row of that kind and destination with nobody listed under may call: the short list reads none of that. */
  const row = (kind: OutboundKind, destination: string, doCall: DoCall[] = []): OutboundRow => ({ kind, destination, ports: '', mayCall: [], othersMay: 0, doCall });

  const http = (workload: string, perSecond: number): DoCall => ({ workload, text: `${perSecond} req/s`, rate: perSecond, requests: perSecond, bytes: 0 });

  /**
   * Fourteen rows that count and twelve with calls, given lowest rate first so that the order is the short
   * list's own: host-1.example at 1 request a second up to host-10.example at 10.
   */
  const LITERAL_ROWS: OutboundRow[] = [
    row('any', ANY_ROW),
    ...Array.from({ length: 10 }, (_, i) => row('seen', `host-${i + 1}.example`, [http('shop / recommender', i + 1)])),
    row('named', 'api.partner.example'),
    row('address-range', RANGE),
    // Two callers: the row's rate is their sum, 11, above host-10.example's 10, though neither caller alone is.
    row('seen', 'host-11.example', [http('shop / recommender', 6), http('payments / postgres', 5)]),
    // No requests, so the text is the bytes; its closed connections give it the highest rate.
    row('unregistered', UNREGISTERED, [{ workload: 'shop / recommender', text: '500 B/s', rate: 20, requests: 0, bytes: 500 }]),
  ];

  /** A caller's long-lived connection: bytes only, with no request and no closed connection, so a rate of 0. */
  const tunnel = (workload: string, perSecond: number, text: string): DoCall => ({ workload, text, rate: 0, requests: 0, bytes: perSecond });

  /**
   * Eleven rows with figures: host-1.example to host-9.example at 1 to 9 requests a second, then two that
   * only move bytes, the quieter one given first, so that only the bytes can put db.partner.example ahead of it.
   */
  const BYTES_ONLY_ROWS: OutboundRow[] = [
    ...Array.from({ length: 9 }, (_, i) => row('seen', `host-${i + 1}.example`, [http('shop / recommender', i + 1)])),
    row('unregistered', UNREGISTERED, [tunnel('shop / recommender', 500, '500 B/s')]),
    row('named', 'db.partner.example', [tunnel('payments / api', 1000, '1 kB/s'), tunnel('payments / postgres', 2000, '2 kB/s')]),
  ];

  /**
   * Twelve rows with calls: host-2.example to host-11.example at 2 to 11 requests a second, and two callers
   * refused on their way to evil.example, each a row of its own at 1.6, given apart. Each alone is below the
   * tenth host; their sum, 3.2, is not.
   */
  const REFUSED_APART_ROWS: OutboundRow[] = [
    row('blocked', BLOCKED_EVIL, [http('payments / api', 1.6)]),
    ...Array.from({ length: 10 }, (_, i) => row('seen', `host-${i + 2}.example`, [http('shop / recommender', i + 2)])),
    row('blocked', BLOCKED_EVIL, [http('payments / postgres', 1.6)]),
  ];

  /** The short list's entries for host-<n>.example at n requests a second, for each n given, in that order. */
  const hostEntries = (...numbers: number[]) => numbers.map((n) => ({ kind: 'seen' as const, destination: `host-${n}.example`, text: `${n} req/s` }));

  // The rows come as a function: outboundRows is called inside the test, never while the table is built.
  it.each<[string, () => readonly OutboundRow[], ShortList]>([
    [
      'OUTBOUND_TRAFFIC',
      () => outboundRows(OUTBOUND, OUTBOUND_TRAFFIC),
      {
        top: [
          { kind: 'seen', destination: 'cdn.example', text: '1 req/s' },
          { kind: 'blocked', destination: BLOCKED_EVIL, text: '0.2 req/s' },
          { kind: 'named', destination: 'api.partner.example', text: '2 kB/s' },
          { kind: 'unregistered', destination: UNREGISTERED, text: '500 B/s' },
        ],
        named: 4,
        total: 7,
      },
    ],
    // 2000 B/s from recommender and 3000 B/s from postgres; neither caller's own text.
    ['two callers of one host', () => outboundRows(OUTBOUND, TWO_CALLERS), { top: [{ kind: 'named', destination: 'api.partner.example', text: '5 kB/s' }], named: 4, total: 4 }],
    // Two rows share the destination text, one per refused caller: one entry, with api's 0.2 and postgres's
    // 0.5 requests a second summed. total still counts rows that are not `any`: three named, two blocked, one range.
    ['two callers refused, one entry', () => outboundRows(OUTBOUND, TWO_REFUSED), { top: [{ kind: 'blocked', destination: BLOCKED_EVIL, text: '0.7 req/s' }], named: 4, total: 6 }],
    // The rows of one destination text are summed before the order and the cap: evil.example's 3.2 requests
    // a second come after host-4.example's 4 and before host-3.example's 3, and host-2.example is left out.
    [
      'one destination in two rows, apart',
      () => REFUSED_APART_ROWS,
      { top: [...hostEntries(11, 10, 9, 8, 7, 6, 5, 4), { kind: 'blocked', destination: BLOCKED_EVIL, text: '3 req/s' }, ...hostEntries(3)], named: 0, total: 12 },
    ],
    // The first 10 by summed rate: host-2.example and host-1.example are left out but still counted.
    [
      'literal rows, the first 10',
      () => LITERAL_ROWS,
      {
        top: [{ kind: 'unregistered', destination: UNREGISTERED, text: '500 B/s' }, ...hostEntries(11, 10, 9, 8, 7, 6, 5, 4, 3)],
        named: 2,
        total: 14,
      },
    ],
    // By summed rate, then, among equal rates, by summed bytes: db.partner.example's callers move 3 kB/s and
    // take the tenth place, and the 500 B/s row is the one the cap leaves out.
    [
      'a destination whose callers move bytes only',
      () => BYTES_ONLY_ROWS,
      {
        top: [...hostEntries(9, 8, 7, 6, 5, 4, 3, 2, 1), { kind: 'named', destination: 'db.partner.example', text: '3 kB/s' }],
        named: 1,
        total: 11,
      },
    ],
  ])('the Internet short list: %s', (_name, rows, expected) => {
    expect(internetShortList(rows())).toStrictEqual(expected);
  });

  const may = (workload: string, netpol: string, istio: string): MayCall => ({ workload, netpol, istio });
  const coredns = may('kube-system / coredns', ANY_ADDRESS, NOT_IN_MESH);
  const kubeProxy = may('kube-system / kube-proxy', ANY_ADDRESS, NOT_IN_MESH);
  const recommender = may('shop / recommender', ANY_ADDRESS, ALLOW_ANY_DEFAULT);

  /** Thirteen workloads outside the mesh with no NetworkPolicy, as a kind cluster's system namespaces hold them. */
  const SYSTEM_WORKLOADS = [
    'istio-system / istiod',
    'istio-system / prometheus',
    'kube-system / coredns',
    'kube-system / etcd-atlas-b-control-plane',
    'kube-system / kindnet',
    'kube-system / kube-apiserver-atlas-b-control-plane',
    'kube-system / kube-controller-manager-atlas-b-control-plane',
    'kube-system / kube-proxy',
    'kube-system / kube-scheduler-atlas-b-control-plane',
    'kube-system / metrics-server',
    'local-path-storage / local-path-provisioner',
    'monitoring / kube-state-metrics',
    'monitoring / node-exporter',
  ];

  it.each<[string, MayCall[], MayCallGroup[]]>([
    ['no entry', [], []],
    ['one entry', [coredns], [{ workloads: ['kube-system / coredns'], more: 0, netpol: ANY_ADDRESS, istio: NOT_IN_MESH }]],
    ['both lines shared', [coredns, kubeProxy], [{ workloads: ['kube-system / coredns', 'kube-system / kube-proxy'], more: 0, netpol: ANY_ADDRESS, istio: NOT_IN_MESH }]],
    [
      'only the NetworkPolicy line shared',
      [coredns, recommender],
      [
        { workloads: ['kube-system / coredns'], more: 0, netpol: ANY_ADDRESS, istio: NOT_IN_MESH },
        { workloads: ['shop / recommender'], more: 0, netpol: ANY_ADDRESS, istio: ALLOW_ANY_DEFAULT },
      ],
    ],
    [
      'only the Istio line shared',
      [may('payments / postgres', ANY_ADDRESS, listed('payments/partner')), may('shop / cart', CART_BLOCKED, listed('payments/partner'))],
      [
        { workloads: ['payments / postgres'], more: 0, netpol: ANY_ADDRESS, istio: listed('payments/partner') },
        { workloads: ['shop / cart'], more: 0, netpol: CART_BLOCKED, istio: listed('payments/partner') },
      ],
    ],
    // recommender's group comes first, as its first entry does, though kube-system sorts first; within a
    // group the entries keep their order: recommender before postgres, coredns before kube-proxy.
    [
      'in the order of each first entry',
      [recommender, coredns, may('payments / postgres', ANY_ADDRESS, ALLOW_ANY_DEFAULT), kubeProxy],
      [
        { workloads: ['shop / recommender', 'payments / postgres'], more: 0, netpol: ANY_ADDRESS, istio: ALLOW_ANY_DEFAULT },
        { workloads: ['kube-system / coredns', 'kube-system / kube-proxy'], more: 0, netpol: ANY_ADDRESS, istio: NOT_IN_MESH },
      ],
    ],
    // The cap is 12: the group names the first 12 and counts monitoring / node-exporter.
    [
      'thirteen workloads, one verdict pair',
      SYSTEM_WORKLOADS.map((w) => may(w, ANY_ADDRESS, NOT_IN_MESH)),
      [
        {
          workloads: [
            'istio-system / istiod',
            'istio-system / prometheus',
            'kube-system / coredns',
            'kube-system / etcd-atlas-b-control-plane',
            'kube-system / kindnet',
            'kube-system / kube-apiserver-atlas-b-control-plane',
            'kube-system / kube-controller-manager-atlas-b-control-plane',
            'kube-system / kube-proxy',
            'kube-system / kube-scheduler-atlas-b-control-plane',
            'kube-system / metrics-server',
            'local-path-storage / local-path-provisioner',
            'monitoring / kube-state-metrics',
          ],
          more: 1,
          netpol: ANY_ADDRESS,
          istio: NOT_IN_MESH,
        },
      ],
    ],
  ])('May call groups the workloads that share both verdict lines: %s', (_name, mayCall, expected) => {
    expect(mayCallGroups(mayCall)).toStrictEqual(expected);
  });

  // Literal rows for the search: cdn.example called by recommender; the partner's host, which api and
  // postgres may call; pay.example.com:8080, called by shop / search, whose pods are gone, so it has no
  // verdict and is under Do call only; and the any row of WITH_KUBE_PROXY.
  const SEARCH_CDN: OutboundRow = { kind: 'seen', destination: 'cdn.example', ports: '', mayCall: [recommender], othersMay: 3, doCall: [http('shop / recommender', 1)] };
  const SEARCH_PARTNER: OutboundRow = {
    kind: 'named',
    destination: 'api.partner.example',
    ports: 'TLS 443',
    mayCall: [may('payments / api', API_DEPENDS, listed('payments/partner')), may('payments / postgres', ANY_ADDRESS, listed('payments/partner'))],
    othersMay: 1,
    doCall: [],
  };
  const SEARCH_GONE: OutboundRow = { kind: 'seen', destination: 'pay.example.com:8080', ports: '', mayCall: [], othersMay: 3, doCall: [http('shop / search', 0.5)] };
  const SEARCH_ANY: OutboundRow = { kind: 'any', destination: ANY_ROW, ports: '', mayCall: [coredns, kubeProxy, recommender], othersMay: 0, doCall: [], note: ANY_NOTE };
  const SEARCHED = [SEARCH_CDN, SEARCH_PARTNER, SEARCH_GONE, SEARCH_ANY];

  /** The any row with only the May call entries given. */
  const anyWith = (...mayCall: MayCall[]): OutboundRow => ({ ...SEARCH_ANY, mayCall });

  it.each<[string, string, OutboundRow[]]>([
    ['no query', '', SEARCHED],
    // The any row goes: none of its workloads holds the query.
    ['a destination', 'partner', [SEARCH_PARTNER]],
    // The partner's row is kept whole, api's line too.
    ['a May call workload', 'postgres', [SEARCH_PARTNER]],
    ['a Do call workload only', 'search', [SEARCH_GONE]],
    ['ignoring case', 'CDN.Example', [SEARCH_CDN]],
    ['the spaces around the query', '  cdn.example  ', [SEARCH_CDN]],
    ["the any row's workloads", 'kube-system', [anyWith(coredns, kubeProxy)]],
    ['a workload of the any row and others', 'recommender', [SEARCH_CDN, anyWith(recommender)]],
    ["the any row's destination", 'other address', [SEARCH_ANY]],
    // The verdict lines are not searched: REGISTRY_ONLY is only in the partner's.
    ['a verdict text, not searched', 'REGISTRY_ONLY', []],
  ])('a search keeps the rows whose destination or workload holds it: %s', (_name, query, expected) => {
    expect(searchOutboundRows(SEARCHED, query)).toStrictEqual(expected);
  });

  /** SHOP as the reader gives it when the role may not list NetworkPolicies: none of them, and the kind in readErrors. */
  const SHOP_NETWORK_POLICIES_REFUSED: ClusterResources = { ...SHOP, networkPolicies: [], readErrors: [{ kind: 'networkpolicies', reason: 'forbidden' }] };

  // For a cluster where the view makes no row, it says that nothing leaves the cluster only when netatlas read every kind
  // the view rests on. Without the NetworkPolicies no any row is made, since one of them may refuse what it would list,
  // and the line `Cannot read NetworkPolicies` above the list says why, so no sentence. Each row also shows that no row is made.
  it.each<[string, ClusterResources, { rows: OutboundRow[]; text: string | undefined }]>([
    ['NetworkPolicies refused, no ServiceEntry, no figures', SHOP_NETWORK_POLICIES_REFUSED, { rows: [], text: undefined }],
    ['every kind read, no pod running', { ...SHOP, pods: [] }, { rows: [], text: 'No destination outside the cluster.' }],
  ])('what the view says of a cluster where it makes no row: %s', (_name, r, expected) => {
    expect({ rows: outboundRows(r, undefined), text: noDestinationText(r) }).toStrictEqual(expected);
  });
});
