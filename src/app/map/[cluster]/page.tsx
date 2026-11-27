import { notFound } from 'next/navigation';
import { ClusterNote } from '@/components/frame/ClusterNote';
import { Frame } from '@/components/frame/Frame';
import { Legend } from '@/components/map/Legend';
import { MapToolbar } from '@/components/map/MapToolbar';
import { PolicyMap } from '@/components/map/PolicyMap';
import { WorkloadPanel } from '@/components/map/WorkloadPanel';
import { mapState, toFlow } from '@/model/flow';
import { cannotReadLine, notReadYet } from '@/model/format';
import { clusterGraph, defaultHidden, workloadDetail } from '@/model/graph';
import { layoutFlow } from '@/server/layout';
import { getStore } from '@/server/store';
import { snapshotOf } from '@/server/views';

export const dynamic = 'force-dynamic';

type Params = Record<string, string | string[] | undefined>;

const NOT_EVALUATED = 'Not evaluated: attached to a waypoint.';

/** The policy map of one cluster. Its namespaces, kinds, chosen workload and search live in the URL. */
export default async function ClusterMap({ params, searchParams }: { params: Promise<{ cluster: string }>; searchParams: Promise<Params> }) {
  const { cluster } = await params;
  const query = await searchParams;
  const store = getStore();
  const c = store ? snapshotOf(store, cluster) : undefined;
  if (!c) notFound();
  const renderedAt = new Date().toISOString();
  const frame = { view: 'map', title: 'Policy map', cluster, search: { value: typeof query.q === 'string' ? query.q : '', placeholder: 'workload or policy' }, renderedAt } as const;
  const note = <ClusterNote c={c} renderedAt={renderedAt} />;
  if (!c.resources) {
    return (
      <Frame {...frame}>
        <main className="page">{c.status.state === 'unreachable' ? note : <p className="empty">{notReadYet(cluster)}</p>}</main>
      </Frame>
    );
  }
  const g = clusterGraph(c.resources);
  const all = g.namespaces.map((n) => n.name);
  const state = mapState(query, all, defaultHidden(c.resources));
  const flow = await layoutFlow(toFlow(g, state));
  const workloads = g.namespaces.flatMap((n) => n.workloads);
  // The side panel opens through the URL, keeping the namespaces, kinds and search as they are.
  const hrefOf = (id: string) => {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (typeof v === 'string' && k !== 'w') next.set(k, v);
    next.set('w', id);
    return `?${next.toString()}`;
  };
  const hrefs = Object.fromEntries(flow.nodes.filter((n) => n.type === 'workload').map((n) => [n.id, hrefOf(n.id)]));
  const q = state.query.toLowerCase();
  const highlighted = q ? workloads.filter((w) => [w.name, ...w.policies.map((p) => p.name)].some((t) => t.toLowerCase().includes(q))).map((w) => w.id) : [];
  const node = state.selected === undefined ? undefined : workloads.find((w) => w.id === state.selected);
  const detail = node ? workloadDetail(g, node.id, state.hidden) : undefined;
  const notes = [
    ...g.unreadable.map(cannotReadLine),
    ...g.notEvaluated.filter((r) => !state.hidden.has(r.namespace)).map((r) => `${r.namespace} / ${r.name}: ${NOT_EVALUATED}`),
  ];
  return (
    <Frame {...frame}>
      <div className="frame-body">
        <main className="page">
          {note}
          {notes.map((n) => (
            <p key={n} className="banner">
              {n}
            </p>
          ))}
          <MapToolbar counts={flow.counts} namespaces={all.map((name) => ({ name, shown: !state.hidden.has(name) }))} show={state.show} />
          {/* The drawn edges cannot be reached by a screen reader, so the text form beside the map is named here. */}
          <p className="muted">Choose a workload on the map to list what may call it and what it may call beside the map.</p>
          <PolicyMap flow={flow} hrefs={hrefs} highlighted={highlighted} {...(node ? { selected: node.id } : {})} />
          <Legend />
        </main>
        {node && detail ? (
          <WorkloadPanel cluster={cluster} node={node} detail={detail} />
        ) : (
          <aside className="side">
            <p className="empty">Choose a workload to see what may call it and what it may call.</p>
          </aside>
        )}
      </div>
    </Frame>
  );
}
