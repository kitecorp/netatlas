import {
  ApisApi,
  CoreV1Api,
  CustomObjectsApi,
  ListWatch,
  Watch,
  type KubeConfig,
  type KubernetesListObject,
  type KubernetesObject,
  type V1DaemonSet,
  type V1Job,
  type V1Namespace,
  type V1Pod,
  type V1ReplicaSet,
} from '@kubernetes/client-node';
import { buildResources } from '@/model/snapshot';
import type { AuthorizationPolicyObject, ClusterResources, Labels, NetworkPolicyObject, WatchedKind } from '@/model/types';
import type { DaemonSetInfo, OwnedObject, RawPod } from '@/model/workloads';
import type { ClusterConfig } from '../registry';
import type { Source, SourceSink } from './source';
import { trimDaemonSet, trimNamespace, trimOwned, trimPod, trimPolicy } from './trim';

/** Every kind the source reads. The chart's reader role grants read on exactly these (a test holds the two together). */
export const WATCHED = [
  { group: '', version: 'v1', resource: 'namespaces' },
  { group: '', version: 'v1', resource: 'pods' },
  { group: 'apps', version: 'v1', resource: 'daemonsets' },
  { group: 'apps', version: 'v1', resource: 'replicasets' },
  { group: 'batch', version: 'v1', resource: 'jobs' },
  { group: 'networking.k8s.io', version: 'v1', resource: 'networkpolicies' },
  { group: 'security.istio.io', version: 'v1', resource: 'authorizationpolicies' },
] as const satisfies readonly { group: string; version: string; resource: WatchedKind }[];

type Watched = (typeof WATCHED)[number];

const ISTIO_GROUP = 'security.istio.io';
/** The pause after the first event of a burst before the snapshot, so a rollout's many events make one snapshot. */
const SNAPSHOT_DELAY_MS = 250;

/** What the cache keeps of each kind. */
interface Held {
  namespaces: { name: string; labels: Labels };
  pods: RawPod;
  daemonsets: DaemonSetInfo;
  replicasets: OwnedObject;
  jobs: OwnedObject;
  networkpolicies: NetworkPolicyObject;
  authorizationpolicies: AuthorizationPolicyObject;
}

const TRIM: { [K in WatchedKind]: (o: KubernetesObject) => Held[K] } = {
  namespaces: (o) => trimNamespace(o as V1Namespace),
  pods: (o) => trimPod(o as V1Pod),
  daemonsets: (o) => trimDaemonSet(o as V1DaemonSet),
  replicasets: (o) => trimOwned(o as V1ReplicaSet),
  jobs: (o) => trimOwned(o as V1Job),
  networkpolicies: (o) => trimPolicy(o as NetworkPolicyObject, { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy' }),
  authorizationpolicies: (o) => trimPolicy(o as AuthorizationPolicyObject, { apiVersion: 'security.istio.io/v1', kind: 'AuthorizationPolicy' }),
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

/**
 * The typed clients turn objects into classes and drop fields they do not know, which would lose a
 * newer NetworkPolicy field the editor must keep. So every grouped kind is listed as plain JSON, the
 * form the watch delivers too; the core kinds are trimmed to known fields, so the typed client serves.
 */
function lister(kc: KubeConfig, w: Watched): () => Promise<KubernetesListObject<KubernetesObject>> {
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
  private readonly informers = new Map<WatchedKind, ListWatch<Cached>>();
  private readonly forbidden = new Set<WatchedKind>();

  constructor(
    private readonly kc: KubeConfig,
    private readonly c: ClusterConfig,
    private readonly sink: SourceSink,
  ) {}

  async start(): Promise<void> {
    const { groups } = await this.kc.makeApiClient(ApisApi).getAPIVersions();
    if (this.stopped) return;
    const istio = groups.some((g) => g.name === ISTIO_GROUP && g.versions.some((v) => v.version === 'v1'));
    for (const w of WATCHED) if (w.group !== ISTIO_GROUP || istio) this.informers.set(w.resource, this.informer(w));
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

  private informer(w: Watched): ListWatch<Cached> {
    const trim = TRIM[w.resource];
    const keep = (o: KubernetesObject): Cached => ({
      metadata: { name: o.metadata?.name, namespace: o.metadata?.namespace, resourceVersion: o.metadata?.resourceVersion },
      value: trim(o),
    });
    const list = lister(this.kc, w);
    const informer = new ListWatch<Cached>(
      pathOf(w),
      new TrimmingWatch(this.kc, keep),
      async () => {
        const l = await list();
        return { metadata: l.metadata, items: l.items.map(keep) };
      },
      false,
    );
    informer.on('change', () => this.schedule());
    informer.on('error', (err) => this.failed(w.resource, informer, err));
    return informer;
  }

  /**
   * A kind netatlas may not read is reported as such and the other kinds go on; any other failure
   * ends the session. Stopping an informer aborts its watch, which reports an error too: ignored.
   */
  private failed(kind: WatchedKind, informer: ListWatch<Cached>, err: unknown) {
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
  private held<K extends WatchedKind>(kind: K): Held[K][] {
    if (this.forbidden.has(kind)) return [];
    return (this.informers.get(kind)?.list() ?? []).map((o) => o.value as Held[K]);
  }

  private snapshot(): ClusterResources {
    return buildResources({
      namespaces: this.held('namespaces'),
      pods: this.held('pods'),
      replicaSets: this.held('replicasets'),
      jobs: this.held('jobs'),
      daemonSets: this.held('daemonsets'),
      networkPolicies: this.held('networkpolicies'),
      authorizationPolicies: this.informers.has('authorizationpolicies') ? this.held('authorizationpolicies') : 'not-installed',
      readErrors: WATCHED.filter((w) => this.forbidden.has(w.resource)).map((w) => ({ kind: w.resource, reason: 'forbidden' as const })),
      istioSettings: this.c.istio,
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
