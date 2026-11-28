import { notFound } from 'next/navigation';
import { ClusterNote, ClusterNotRead } from '@/components/frame/ClusterNote';
import { Frame } from '@/components/frame/Frame';
import { InternetPanel } from '@/components/map/InternetPanel';
import { Legend } from '@/components/map/Legend';
import { MapToolbar } from '@/components/map/MapToolbar';
import { PolicyMap } from '@/components/map/PolicyMap';
import { WorkloadPanel } from '@/components/map/WorkloadPanel';
import { cannotReadLines } from '@/model/cannot-read';
import { OUTSIDE } from '@/model/classes';
import { firstValue, mapState, toFlow } from '@/model/flow';
import { clusterGraph, defaultHidden, workloadDetail } from '@/model/graph';
import { internetShortList, outboundRows } from '@/model/outbound';
import { trafficNote } from '@/model/traffic-status';
import { layoutFlow } from '@/server/layout';
import { getStore } from '@/server/store';
import { snapshotOf } from '@/server/views';

export const dynamic = 'force-dynamic';

type Params = Record<string, string | string[] | undefined>;

const NOT_EVALUATED = 'Not evaluated: attached to a waypoint.';

/**
 * The policy map of one cluster. Its namespaces, kinds, chosen node and search live in the URL. Choosing
 * the Internet opens the short form of the Outbound view, which shows traffic, so only then does each
 * traffic poll render the page again.
 */
export default async function ClusterMap({ params, searchParams }: { params: Promise<{ cluster: string }>; searchParams: Promise<Params> }) {
  const { cluster } = await params;
  const query = await searchParams;
  const store = getStore();
  const c = store ? snapshotOf(store, cluster) : undefined;
  if (!c) notFound();
  const renderedAt = new Date().toISOString();
  const frame = { view: 'map', title: 'Policy map', cluster, search: { value: firstValue(query.q) ?? '', placeholder: 'workload or policy' }, renderedAt } as const;
  if (!c.resources) {
    return (
      <Frame {...frame}>
        <main className="page">
          <ClusterNotRead c={c} renderedAt={renderedAt} />
        </main>
      </Frame>
    );
  }
  const g = clusterGraph(c.resources);
  const all = g.namespaces.map((n) => n.name);
  const state = mapState(query, all, defaultHidden(c.resources));
  // A cluster with a traffic source always has the Internet node, so the traffic view lays out this same flow.
  const flow = await layoutFlow(toFlow(g, { ...state, outside: c.traffic !== undefined }));
  const workloads = g.namespaces.flatMap((n) => n.workloads);
  // The side panel opens through the URL, keeping the namespaces, kinds and search as they are.
  const hrefOf = (id: string) => {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      const value = firstValue(v);
      if (value !== undefined && k !== 'w') next.set(k, value);
    }
    next.set('w', id);
    return `?${next.toString()}`;
  };
  const hrefs = Object.fromEntries(flow.nodes.filter((n) => n.type === 'workload' || n.id === OUTSIDE).map((n) => [n.id, hrefOf(n.id)]));
  const q = state.query.toLowerCase();
  const highlighted = q ? workloads.filter((w) => [w.name, ...w.policies.map((p) => p.name)].some((t) => t.toLowerCase().includes(q))).map((w) => w.id) : [];
  const internet = state.selected === OUTSIDE;
  const node = state.selected === undefined ? undefined : workloads.find((w) => w.id === state.selected);
  const detail = node ? workloadDetail(g, node.id, state.hidden) : undefined;
  const selected = internet ? OUTSIDE : node?.id;
  const notes = [
    ...cannotReadLines(c.resources),
    ...g.notEvaluated.filter((r) => !state.hidden.has(r.namespace)).map((r) => `${r.namespace} / ${r.name}: ${NOT_EVALUATED}`),
  ];
  return (
    <Frame {...frame} traffic={internet}>
      <div className="frame-body">
        <main className="page">
          <ClusterNote c={c} renderedAt={renderedAt} />
          {notes.map((n) => (
            <p key={n} className="banner">
              {n}
            </p>
          ))}
          <MapToolbar counts={flow.counts} namespaces={all.map((name) => ({ name, shown: !state.hidden.has(name) }))} show={state.show} />
          {/* The drawn edges cannot be reached by a screen reader, so the text form beside the map is named here. */}
          <p className="muted">Choose a workload on the map to list what may call it and what it may call beside the map.</p>
          <PolicyMap name={`Policy map of ${cluster}`} flow={flow} hrefs={hrefs} highlighted={highlighted} {...(selected ? { selected } : {})} />
          <Legend />
        </main>
        {internet ? (
          <InternetPanel
            cluster={cluster}
            list={internetShortList(outboundRows(c.resources, c.traffic))}
            note={trafficNote(cluster, c.traffic)}
            measured={c.traffic?.figures !== undefined}
            renderedAt={renderedAt}
          />
        ) : node && detail ? (
          // A panel of its own for each workload, so that choosing another one moves the focus to its heading.
          <WorkloadPanel key={node.id} cluster={cluster} node={node} detail={detail} />
        ) : (
          <aside className="side">
            <p className="empty">Choose a workload to see what may call it and what it may call.</p>
          </aside>
        )}
      </div>
    </Frame>
  );
}
