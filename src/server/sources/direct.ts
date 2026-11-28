import {
  ApisApi,
  CoreV1Api,
  CustomObjectsApi,
  ListWatch,
  Watch,
  type KubeConfig,
  type KubernetesListObject,
  type KubernetesObject,
  type V1ConfigMap,
  type V1DaemonSet,
  type V1Job,
  type V1Namespace,
  type V1Pod,
  type V1ReplicaSet,
} from '@kubernetes/client-node';
import { buildResources } from '@/model/snapshot';
import type {
  AuthorizationPolicyObject,
  ClusterResources,
  Labels,
  MeshSettings,
  NetworkPolicyObject,
  ServiceEntryObject,
  SidecarObject,
  WatchedKind,
} from '@/model/types';
import type { DaemonSetInfo, OwnedObject, RawPod } from '@/model/workloads';
import type { ClusterConfig } from '../registry';
import type { Source, SourceSink } from './source';
import { trimDaemonSet, trimMeshConfig, trimNamespace, trimOwned, trimPod, trimPolicy } from './trim';

/** Every kind the source reads. The chart's reader role grants read on exactly these (a test holds the two together). */
export const WATCHED = [
  { group: '', version: 'v1', resource: 'namespaces' },
  { group: '', version: 'v1', resource: 'pods' },
  { group: 'apps', version: 'v1', resource: 'daemonsets' },
  { group: 'apps', version: 'v1', resource: 'replicasets' },
  { group: 'batch', version: 'v1', resource: 'jobs' },
  { group: 'networking.istio.io', version: 'v1', resource: 'serviceentries' },
  { group: 'networking.istio.io', version: 'v1', resource: 'sidecars' },
  { group: 'networking.k8s.io', version: 'v1', resource: 'networkpolicies' },
  { group: 'security.istio.io', version: 'v1', resource: 'authorizationpolicies' },
] as const satisfies readonly { group: string; version: string; resource: WatchedKind }[];

type Watched = (typeof WATCHED)[number];

/** Istio's groups, which a cluster serves only while Istio is installed; every other group is always there. */
const ISTIO_GROUPS: ReadonlySet<string> = new Set(['security.istio.io', 'networking.istio.io']);
/** The mesh config is the ConfigMap `istio` in Istio's root namespace, read only while Istio's networking group is served. */
const MESH_CONFIG_GROUP = 'networking.istio.io';
/** The reader role may read only the ConfigMap `istio`, and RBAC lets a list or watch read a named object only with this selector. */
const MESH_CONFIG_SELECTOR = 'metadata.name=istio';
/** The pause after the first event of a burst before the snapshot, so a rollout's many events make one snapshot. */
const SNAPSHOT_DELAY_MS = 250;

/** What the source reads: the watched kinds, and the mesh config, which is one ConfigMap and no kind of its own. */
type ReadKind = WatchedKind | 'meshconfig';

/** What the cache keeps of each kind. */
interface Held {
  namespaces: { name: string; labels: Labels };
  pods: RawPod;
  daemonsets: DaemonSetInfo;
  replicasets: OwnedObject;
  jobs: OwnedObject;
  serviceentries: ServiceEntryObject;
  sidecars: SidecarObject;
  networkpolicies: NetworkPolicyObject;
  authorizationpolicies: AuthorizationPolicyObject;
  meshconfig: MeshSettings;
}

const TRIM: { [K in ReadKind]: (o: KubernetesObject) => Held[K] } = {
  namespaces: (o) => trimNamespace(o as V1Namespace),
  pods: (o) => trimPod(o as V1Pod),
  daemonsets: (o) => trimDaemonSet(o as V1DaemonSet),
  replicasets: (o) => trimOwned(o as V1ReplicaSet),
  jobs: (o) => trimOwned(o as V1Job),
  serviceentries: (o) => trimPolicy(o as ServiceEntryObject, { apiVersion: 'networking.istio.io/v1', kind: 'ServiceEntry' }),
  sidecars: (o) => trimPolicy(o as SidecarObject, { apiVersion: 'networking.istio.io/v1', kind: 'Sidecar' }),
  networkpolicies: (o) => trimPolicy(o as NetworkPolicyObject, { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy' }),
  authorizationpolicies: (o) => trimPolicy(o as AuthorizationPolicyObject, { apiVersion: 'security.istio.io/v1', kind: 'AuthorizationPolicy' }),
  // A ConfigMap istio with no data is Istio's defaults; only an absent one is missing.
  meshconfig: (o) => trimMeshConfig((o as V1ConfigMap).data ?? {}),
};

/** A cache entry: the keys ListWatch files and resumes by, and the trimmed object. */
interface Cached {
  metadata: { name?: string; namespace?: string; resourceVersion?: string };
  value: unknown;
}

/** Watch events that carry an object; ERROR carries a Status and BOOKMARK only a resourceVersion, which pass as they are. */
const OBJECT_EVENTS = new Set(['ADDED', 'MODIFIED', 'DELETED']);

/**
 * ListWatch has no hook to transform what it caches, so the trimming happens in the watch it reads
 * from (and in its list function): only trimmed objects ever reach the cache.
 */
class TrimmingWatch extends Watch {
  constructor(
    kc: KubeConfig,
    private readonly trim: (o: KubernetesObject) => Cached,
  ) {
    super(kc);
  }

  override watch(...[path, query, callback, done]: Parameters<Watch['watch']>): ReturnType<Watch['watch']> {
    return super.watch(path, query, (phase, obj) => callback(phase, OBJECT_EVENTS.has(phase) ? this.trim(obj) : obj), done);
  }
}

const pathOf = (w: Watched) => (w.group === '' ? `/api/${w.version}/${w.resource}` : `/apis/${w.group}/${w.version}/${w.resource}`);

type Lister = () => Promise<KubernetesListObject<KubernetesObject>>;

/**
 * The typed clients turn objects into classes and drop fields they do not know, which would lose a
 * newer NetworkPolicy field the editor must keep, or an Istio field. So every grouped kind is listed
 * as plain JSON, the form the watch delivers too; the core kinds are trimmed to known fields, so the
 * typed client serves.
 */
function lister(kc: KubeConfig, w: Watched): Lister {
  if (w.group === '') {
    const core = kc.makeApiClient(CoreV1Api);
    return w.resource === 'pods' ? () => core.listPodForAllNamespaces() : () => core.listNamespace();
  }
  const custom = kc.makeApiClient(CustomObjectsApi);
  return () => custom.listClusterCustomObject({ group: w.group, version: w.version, plural: w.resource });
}

/** A list that fails carries the HTTP status as `code` (ApiException); a watch that fails, as `statusCode`. */
const isForbidden = (err: unknown) => {
  const e = err as { code?: unknown; statusCode?: unknown } | undefined;
  return e?.code === 403 || e?.statusCode === 403;
};

/** One run of the source, from start to stop. A restart makes a new one, so nothing carries over. */
class Session {
  private stopped = false;
  private ready = false;
  private timer: NodeJS.Timeout | undefined;
  private readonly informers = new Map<ReadKind, ListWatch<Cached>>();
  private readonly forbidden = new Set<ReadKind>();

  constructor(
    private readonly kc: KubeConfig,
    private readonly c: ClusterConfig,
    private readonly sink: SourceSink,
  ) {}

  async start(): Promise<void> {
    const { groups } = await this.kc.makeApiClient(ApisApi).getAPIVersions();
    if (this.stopped) return;
    const served = (group: string, version: string) => groups.some((g) => g.name === group && g.versions.some((v) => v.version === version));
    for (const w of WATCHED) {
      if (ISTIO_GROUPS.has(w.group) && !served(w.group, w.version)) continue;
      this.informers.set(w.resource, this.informer(w.resource, pathOf(w), lister(this.kc, w)));
    }
    if (served(MESH_CONFIG_GROUP, 'v1')) this.informers.set('meshconfig', this.meshConfigInformer());
    // Each start resolves once its first list is in, so the first snapshot holds every kind at once.
    await Promise.all([...this.informers.values()].map((i) => i.start()));
    // ListWatch opens its watch after the list even when stopped during it, so a stop that came
    // meanwhile has to be repeated now that the watches exist.
    if (this.stopped) return this.stopInformers();
    this.ready = true;
    this.schedule();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.stopInformers();
  }

  private async stopInformers() {
    await Promise.all([...this.informers.values()].map((i) => i.stop()));
  }

  /** The ConfigMap `istio` alone: the list and the watch both select it by name, as the role requires. */
  private meshConfigInformer(): ListWatch<Cached> {
    const namespace = this.c.istio.rootNamespace;
    const core = this.kc.makeApiClient(CoreV1Api);
    return this.informer(
      'meshconfig',
      `/api/v1/namespaces/${namespace}/configmaps`,
      () => core.listNamespacedConfigMap({ namespace, fieldSelector: MESH_CONFIG_SELECTOR }),
      MESH_CONFIG_SELECTOR,
    );
  }

  private informer(kind: ReadKind, path: string, list: Lister, fieldSelector?: string): ListWatch<Cached> {
    const trim = TRIM[kind];
    const keep = (o: KubernetesObject): Cached => ({
      metadata: { name: o.metadata?.name, namespace: o.metadata?.namespace, resourceVersion: o.metadata?.resourceVersion },
      value: trim(o),
    });
    const informer = new ListWatch<Cached>(
      path,
      new TrimmingWatch(this.kc, keep),
      async () => {
        const l = await list();
        return { metadata: l.metadata, items: l.items.map(keep) };
      },
      false,
      undefined,
      fieldSelector,
    );
    informer.on('change', () => this.schedule());
    informer.on('error', (err) => this.failed(kind, informer, err));
    return informer;
  }

  /**
   * A kind netatlas may not read is reported as such and the other kinds go on; any other failure
   * ends the session. Stopping an informer aborts its watch, which reports an error too: ignored.
   */
  private failed(kind: ReadKind, informer: ListWatch<Cached>, err: unknown) {
    if (this.stopped || this.forbidden.has(kind)) return;
    if (!isForbidden(err)) return this.sink.lost(err);
    this.forbidden.add(kind);
    void informer.stop();
    this.schedule();
  }

  private schedule() {
    if (!this.ready || this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.stopped) this.sink.update({ kind: 'resources', resources: this.snapshot(), at: new Date() });
    }, SNAPSHOT_DELAY_MS);
    this.timer.unref();
  }

  /** What the cache holds of a kind; nothing for a kind that became forbidden, whose stopped informer still holds the old objects. */
  private held<K extends ReadKind>(kind: K): Held[K][] {
    if (this.forbidden.has(kind)) return [];
    return (this.informers.get(kind)?.list() ?? []).map((o) => o.value as Held[K]);
  }

  /** A kind of Istio's that the cluster does not serve is not installed, which is not the same as having none. */
  private installed<K extends WatchedKind>(kind: K): Held[K][] | 'not-installed' {
    return this.informers.has(kind) ? this.held(kind) : 'not-installed';
  }

  private meshConfig(): MeshSettings {
    if (!this.informers.has('meshconfig')) return { state: 'not-installed' };
    if (this.forbidden.has('meshconfig')) return { state: 'forbidden' };
    return this.held('meshconfig')[0] ?? { state: 'missing' };
  }

  private snapshot(): ClusterResources {
    return buildResources({
      namespaces: this.held('namespaces'),
      pods: this.held('pods'),
      replicaSets: this.held('replicasets'),
      jobs: this.held('jobs'),
      daemonSets: this.held('daemonsets'),
      networkPolicies: this.held('networkpolicies'),
      authorizationPolicies: this.installed('authorizationpolicies'),
      // The mesh config is no kind of its own: a refusal to read it shows in meshConfig instead.
      readErrors: WATCHED.filter((w) => this.forbidden.has(w.resource)).map((w) => ({ kind: w.resource, reason: 'forbidden' as const })),
      istioSettings: this.c.istio,
      serviceEntries: this.installed('serviceentries'),
      sidecars: this.installed('sidecars'),
      meshConfig: this.meshConfig(),
    });
  }
}

/** Reads one cluster through its Kubernetes API with an informer per watched kind. */
export function directSource(kc: KubeConfig, c: ClusterConfig): Source {
  let session: Session | undefined;
  return {
    label: 'Kubernetes API',
    // The session is replaced before anything is awaited, so a stop that comes during a start stops the new one.
    async start(sink) {
      const previous = session;
      const next = new Session(kc, c, sink);
      session = next;
      await previous?.stop();
      await next.start();
    },
    async stop() {
      const current = session;
      session = undefined;
      await current?.stop();
    },
  };
}
