// The objects netatlas reads from a cluster. Policy objects mirror networking.k8s.io/v1 and
// security.istio.io/v1, and each carries `[k: string]: unknown` so that keys netatlas does not
// know (newer API fields, vendor annotations) survive a round trip through the editor.
import type { ClusterStatus } from './status';
import type { TrafficSnapshot } from './traffic-status';

export type Labels = Readonly<Record<string, string>>;
export type Protocol = 'TCP' | 'UDP' | 'SCTP';
export type Mesh = 'sidecar' | 'ambient' | 'none';
export type Enforcer = 'Calico' | 'Cilium' | 'AWS VPC CNI';
export type IstioMode = 'sidecars' | 'ambient' | 'none';
/** What a pod's Istio proxy runs as: the word after `proxy` in the istio-proxy container's args. */
export type ProxyRole = 'sidecar' | 'router' | 'waypoint';
export type WatchedKind =
  | 'namespaces'
  | 'pods'
  | 'replicasets'
  | 'jobs'
  | 'daemonsets'
  | 'networkpolicies'
  | 'authorizationpolicies'
  | 'serviceentries'
  | 'sidecars';

export interface PolicyRef {
  readonly kind: 'NetworkPolicy' | 'AuthorizationPolicy';
  readonly namespace: string;
  readonly name: string;
}

export interface WorkloadRef {
  readonly kind: string;
  readonly name: string;
}

export interface ContainerPort {
  readonly name?: string;
  readonly port: number;
  readonly protocol: Protocol;
}

export interface PodInfo {
  readonly name: string;
  readonly namespace: string;
  readonly labels: Labels;
  readonly serviceAccount: string;
  readonly workload: WorkloadRef;
  readonly phase: string;
  readonly ports: readonly ContainerPort[];
  readonly mesh: Mesh;
  readonly istioRevision?: string;
  readonly proxyRole?: ProxyRole;
  /**
   * The ConfigMap a non-empty `SHARED_MESH_CONFIG` in one of the pod's containers names: istiod loads it
   * as a second source of the mesh config (pilot/pkg/features/pilot.go:219-220, bootstrap/mesh.go:112-114).
   */
  readonly sharedMeshConfig?: string;
}

export interface ObjectMeta {
  readonly name: string;
  readonly namespace: string;
  readonly resourceVersion?: string;
  readonly labels?: Labels;
  readonly annotations?: Labels;
  readonly [k: string]: unknown;
}

export interface LabelSelectorRequirement {
  readonly key: string;
  readonly operator: 'In' | 'NotIn' | 'Exists' | 'DoesNotExist';
  readonly values?: readonly string[];
  readonly [k: string]: unknown;
}

export interface LabelSelector {
  readonly matchLabels?: Labels;
  readonly matchExpressions?: readonly LabelSelectorRequirement[];
  readonly [k: string]: unknown;
}

export interface IPBlock {
  readonly cidr: string;
  readonly except?: readonly string[];
  readonly [k: string]: unknown;
}

export interface Peer {
  readonly podSelector?: LabelSelector;
  readonly namespaceSelector?: LabelSelector;
  readonly ipBlock?: IPBlock;
  readonly [k: string]: unknown;
}

export interface PolicyPort {
  readonly protocol?: Protocol;
  readonly port?: number | string;
  readonly endPort?: number;
  readonly [k: string]: unknown;
}

/** An ingress rule carries `from`, an egress rule `to`; both carry `ports`. */
export interface PolicyRule {
  readonly from?: readonly Peer[];
  readonly to?: readonly Peer[];
  readonly ports?: readonly PolicyPort[];
  readonly [k: string]: unknown;
}

export interface NetworkPolicySpec {
  readonly podSelector: LabelSelector;
  readonly policyTypes?: readonly ('Ingress' | 'Egress')[];
  readonly ingress?: readonly PolicyRule[];
  readonly egress?: readonly PolicyRule[];
  readonly [k: string]: unknown;
}

export interface NetworkPolicyObject {
  readonly apiVersion?: string;
  readonly kind?: string;
  readonly metadata: ObjectMeta;
  readonly spec: NetworkPolicySpec;
  readonly [k: string]: unknown;
}

export interface IstioSource {
  readonly principals?: readonly string[];
  readonly notPrincipals?: readonly string[];
  readonly requestPrincipals?: readonly string[];
  readonly notRequestPrincipals?: readonly string[];
  readonly namespaces?: readonly string[];
  readonly notNamespaces?: readonly string[];
  readonly serviceAccounts?: readonly string[];
  readonly notServiceAccounts?: readonly string[];
  readonly ipBlocks?: readonly string[];
  readonly notIpBlocks?: readonly string[];
  readonly remoteIpBlocks?: readonly string[];
  readonly notRemoteIpBlocks?: readonly string[];
  readonly trustDomains?: readonly string[];
  readonly notTrustDomains?: readonly string[];
  readonly [k: string]: unknown;
}

export interface IstioOperation {
  readonly hosts?: readonly string[];
  readonly notHosts?: readonly string[];
  readonly ports?: readonly string[];
  readonly notPorts?: readonly string[];
  readonly methods?: readonly string[];
  readonly notMethods?: readonly string[];
  readonly paths?: readonly string[];
  readonly notPaths?: readonly string[];
  readonly [k: string]: unknown;
}

export interface IstioCondition {
  readonly key: string;
  readonly values?: readonly string[];
  readonly notValues?: readonly string[];
  readonly [k: string]: unknown;
}

export interface IstioRule {
  readonly from?: readonly { readonly source?: IstioSource; readonly [k: string]: unknown }[];
  readonly to?: readonly { readonly operation?: IstioOperation; readonly [k: string]: unknown }[];
  readonly when?: readonly IstioCondition[];
  readonly [k: string]: unknown;
}

export interface IstioTargetRef {
  readonly group?: string;
  readonly kind: string;
  readonly name: string;
  readonly namespace?: string;
  readonly [k: string]: unknown;
}

export interface AuthorizationPolicySpec {
  readonly selector?: { readonly matchLabels?: Labels; readonly [k: string]: unknown };
  readonly targetRef?: IstioTargetRef;
  readonly targetRefs?: readonly IstioTargetRef[];
  readonly action?: 'ALLOW' | 'DENY' | 'AUDIT' | 'CUSTOM';
  readonly provider?: { readonly name: string; readonly [k: string]: unknown };
  readonly rules?: readonly IstioRule[];
  readonly [k: string]: unknown;
}

export interface AuthorizationPolicyObject {
  readonly apiVersion?: string;
  readonly kind?: string;
  readonly metadata: ObjectMeta;
  readonly spec: AuthorizationPolicySpec;
  readonly [k: string]: unknown;
}

export interface ServiceEntrySpec {
  readonly hosts: readonly string[];
  readonly addresses?: readonly string[];
  readonly ports?: readonly { readonly number: number; readonly name: string; readonly protocol?: string; readonly targetPort?: number }[];
  readonly location?: 'MESH_EXTERNAL' | 'MESH_INTERNAL';
  readonly resolution?: string;
  /** `ports` maps a port's name to the endpoint's own port for it (WorkloadEntry.ports). */
  readonly endpoints?: readonly { readonly address?: string; readonly ports?: Readonly<Record<string, number>> }[];
  readonly exportTo?: readonly string[];
  readonly [k: string]: unknown;
}

export interface ServiceEntryObject {
  readonly apiVersion: 'networking.istio.io/v1';
  readonly kind: 'ServiceEntry';
  readonly metadata: ObjectMeta;
  readonly spec: ServiceEntrySpec;
}

export interface SidecarObject {
  readonly apiVersion: 'networking.istio.io/v1';
  readonly kind: 'Sidecar';
  readonly metadata: ObjectMeta;
  readonly spec: {
    readonly workloadSelector?: { readonly labels?: Labels };
    readonly egress?: readonly { readonly hosts: readonly string[]; readonly port?: unknown; readonly [k: string]: unknown }[];
    readonly outboundTrafficPolicy?: { readonly mode?: string; readonly [k: string]: unknown };
    readonly [k: string]: unknown;
  };
}

export type OutboundSetting = 'ALLOW_ANY' | 'REGISTRY_ONLY' | 'ALLOW_ANY_DYNAMIC_DNS';

/**
 * The mesh config's serviceEntryVisibility, a message (api mesh/v1alpha1/config.proto:1689-1693,
 * 1785-1835), as netatlas reads it: whether sidecars honour it, its default visibility as written, and
 * how many policies it lists.
 */
export interface ServiceEntryVisibility {
  readonly applyToSidecars: boolean;
  readonly defaultVisibility?: string;
  readonly policies: number;
}

/** The mesh config's settings netatlas reads, from the ConfigMap `istio` in the Istio root namespace. */
export type MeshSettings =
  | {
      readonly state: 'found';
      readonly outbound: OutboundSetting | 'unset' | 'no-mode' | { readonly other: string };
      readonly serviceEntryVisibility?: ServiceEntryVisibility;
      readonly defaultServiceExportTo?: readonly string[];
    }
  | { readonly state: 'missing' | 'forbidden' | 'not-installed' | 'unparsable' };

export interface ClusterResources {
  readonly namespaces: readonly { readonly name: string; readonly labels: Labels }[];
  readonly pods: readonly PodInfo[];
  readonly networkPolicies: readonly NetworkPolicyObject[];
  /** 'not-installed' when the cluster has no AuthorizationPolicy CRD, which differs from having none. */
  readonly authorizationPolicies: readonly AuthorizationPolicyObject[] | 'not-installed';
  readonly readErrors: readonly { readonly kind: WatchedKind; readonly reason: 'forbidden' }[];
  readonly enforcer: Enforcer | null;
  readonly istio: IstioMode;
  readonly istioSettings: { readonly rootNamespace: string; readonly trustDomain: string };
  readonly serviceEntries: readonly ServiceEntryObject[] | 'not-installed';
  readonly sidecars: readonly SidecarObject[] | 'not-installed';
  readonly meshConfig: MeshSettings;
}

/** One cluster as the views read it: its status, and the last resources read from it (kept while it is unreachable). */
export interface ClusterSnapshot {
  readonly name: string;
  readonly status: ClusterStatus;
  readonly resources?: ClusterResources;
  /**
   * The last moment the resources were known to be the cluster's: each snapshot sets it, and so does
   * each answer of the API server while the reader runs. It stops when the reader does, so it is the
   * one age of the data every page shows.
   */
  readonly syncedAt?: Date;
  /** Whether the reader runs and holds the cluster's current state. */
  readonly synced: boolean;
  /** The cluster's traffic source; absent when its registry entry names no Prometheus. */
  readonly traffic?: TrafficSnapshot;
}
