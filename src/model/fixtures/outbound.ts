// SHOP with what decides what each workload may call outside the cluster: ServiceEntries, Sidecars,
// an egress NetworkPolicy to an address block, and an empty mesh config (Istio's defaults).
import type { TrafficSnapshot } from '../traffic-status';
import type { ClusterResources, ServiceEntryObject, ServiceEntrySpec, SidecarObject } from '../types';
import { networkPolicy, SHOP, upsert } from './shop';
import { bytes, call, closed, requests, withFigures } from './traffic';

export const serviceEntry = (namespace: string, name: string, spec: ServiceEntrySpec): ServiceEntryObject => ({
  apiVersion: 'networking.istio.io/v1',
  kind: 'ServiceEntry',
  metadata: { name, namespace },
  spec,
});

/** A Sidecar; the creation time decides between two whose selectors match one pod. */
export const sidecar = (namespace: string, name: string, spec: SidecarObject['spec'], creationTimestamp?: string): SidecarObject => ({
  apiVersion: 'networking.istio.io/v1',
  kind: 'Sidecar',
  metadata: { name, namespace, ...(creationTimestamp === undefined ? {} : { creationTimestamp }) },
  spec,
});

const tls443 = [{ number: 443, name: 'tls', protocol: 'TLS' }];

export const OUTBOUND: ClusterResources = {
  ...SHOP,
  networkPolicies: [
    ...SHOP.networkPolicies,
    networkPolicy('payments', 'api-partner', {
      podSelector: { matchLabels: { app: 'api' } },
      policyTypes: ['Egress'],
      egress: [{ to: [{ ipBlock: { cidr: '203.0.113.0/24', except: ['203.0.113.128/25'] } }], ports: [{ protocol: 'TCP', port: 443 }] }],
    }),
  ],
  serviceEntries: [
    serviceEntry('payments', 'partner', { hosts: ['api.partner.example'], ports: tls443, resolution: 'DNS' }),
    serviceEntry('shop', 'fonts', { hosts: ['*.fonts.example'], exportTo: ['.'], ports: tls443 }),
    // STATIC connects to its endpoints, so a working STATIC entry has one.
    serviceEntry('shop', 'static', { hosts: ['static.example'], ports: tls443, resolution: 'STATIC', endpoints: [{ address: '203.0.113.10' }] }),
    serviceEntry('payments', 'internal', { hosts: ['ledger.internal'], location: 'MESH_INTERNAL' }),
  ],
  sidecars: [
    sidecar('payments', 'registry-only', { outboundTrafficPolicy: { mode: 'REGISTRY_ONLY' } }),
    sidecar(
      'shop',
      'cart-registry',
      { workloadSelector: { labels: { app: 'cart' } }, outboundTrafficPolicy: {}, egress: [{ hosts: ['./*', 'payments/api.partner.example'] }] },
      '2026-11-02T00:00:00Z',
    ),
    sidecar('shop', 'frontend-tilde', {
      workloadSelector: { labels: { app: 'frontend' } },
      outboundTrafficPolicy: { mode: 'REGISTRY_ONLY' },
      egress: [{ hosts: ['~/*.fonts.example', '*/*'] }],
    }),
  ],
  meshConfig: { state: 'found', outbound: 'unset' },
};

/**
 * A call that leaves the cluster, as the caller's sidecar reports it when no endpoint names the
 * destination: destination workload `unknown/unknown`, and the destination service and its name as Istio
 * writes them for that kind of call. That is the form of PassthroughCluster and BlackHoleCluster. A call to
 * a ServiceEntry host is reported with the endpoint Istio makes for the entry as its destination workload:
 * a DNS entry without endpoints or workload selector gets an endpoint per port, named after the entry, in
 * the entry's namespace, and an entry with endpoints names each `<entry>-<index>`, in the entry's
 * namespace (serviceentry/conversion.go:347-351, 363-391, 438-442, 499-502). Which kinds a caller can
 * report depends on its outbound mode: under REGISTRY_ONLY a host no ServiceEntry registers goes to
 * BlackHoleCluster, and only under ALLOW_ANY to PassthroughCluster.
 */
export const callOut = (from: string, service: string, serviceName: string) =>
  call('source', from, 'unknown/unknown', { destination_service: service, destination_service_name: serviceName });

/**
 * TLS to the partner through its ServiceEntry, which Istio reports with the entry's host as the destination
 * service and payments/partner as the destination workload (a DNS entry without endpoints). This sample
 * keeps the unknown workload of callOut instead; the Outbound rows' test shows that both forms give one row.
 */
const toPartner = callOut('shop/recommender', 'api.partner.example', 'api.partner.example');
/**
 * TLS or TCP that ALLOW_ANY let out to an address no ServiceEntry registers: Istio keeps no host, as in the
 * kind battery's TCP series. recommender is the one workload in the mesh under ALLOW_ANY.
 */
const unregistered = callOut('shop/recommender', 'unknown', 'PassthroughCluster');

/** OUTBOUND's calls out of the cluster, each reported by its caller's proxy (`reporter=source`); the partner's in callOut's form. */
export const OUTBOUND_TRAFFIC: TrafficSnapshot = withFigures({
  requests: [
    // HTTP that api's REGISTRY_ONLY refused still names the host it asked for. No response flag decides an Outbound row.
    requests(callOut('payments/api', 'evil.example', 'BlackHoleCluster'), '502', '-', 0.2),
    // Plain HTTP that recommender's ALLOW_ANY let out to a host no ServiceEntry registers: the Host header, with its port.
    requests(callOut('shop/recommender', 'cdn.example:8080', 'PassthroughCluster'), '200', '-', 1),
  ],
  requestBytes: [bytes(toPartner, 1000), bytes(unregistered, 250)],
  responseBytes: [bytes(toPartner, 1000), bytes(unregistered, 250)],
  closed: [closed(toPartner, '-', 0.1)],
});

const sameSidecar = (a: SidecarObject, b: SidecarObject) => a.metadata.namespace === b.metadata.namespace && a.metadata.name === b.metadata.name;

/** `r` with each Sidecar given replacing the one of the same namespace and name, or added after the others. */
export function withSidecars(r: ClusterResources, ...sidecars: readonly SidecarObject[]): ClusterResources {
  let list = r.sidecars === 'not-installed' ? [] : r.sidecars;
  for (const s of sidecars) list = upsert(list, s, sameSidecar);
  return { ...r, sidecars: list };
}
