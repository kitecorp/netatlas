import { notFound } from 'next/navigation';
import { ClusterNote, ClusterNotRead } from '@/components/frame/ClusterNote';
import { Frame } from '@/components/frame/Frame';
import { PolicyMap } from '@/components/map/PolicyMap';
import { StandsOut } from '@/components/traffic/StandsOut';
import { TrafficLegend } from '@/components/traffic/TrafficLegend';
import { TrafficNote } from '@/components/traffic/TrafficNote';
import { TrafficToolbar } from '@/components/traffic/TrafficToolbar';
import { cannotReadLines } from '@/model/cannot-read';
import { firstValue, mapState, toFlow } from '@/model/flow';
import { clusterGraph, defaultHidden } from '@/model/graph';
import { readableNames } from '@/model/readable-names';
import { trafficModel } from '@/model/traffic';
import { extraFlowNodes, trafficEdges, trafficNodes } from '@/model/traffic-flow';
import { trafficNote } from '@/model/traffic-status';
import { layoutFlow, withExtraNodes } from '@/server/layout';
import { getStore } from '@/server/store';
import { snapshotOf } from '@/server/views';

export const dynamic = 'force-dynamic';

type Params = Record<string, string | string[] | undefined>;

/** The map's default toggles: the traffic view lays out the map's own flow, so the positions are the map's. */
const BOTH_KINDS = { networkpolicy: true, istio: true } as const;

/**
 * The traffic of one cluster, drawn on the policy map's layout. Its namespaces and whether it compares
 * with the policies live in the URL; each traffic poll renders it again.
 */
export default async function ClusterTraffic({ params, searchParams }: { params: Promise<{ cluster: string }>; searchParams: Promise<Params> }) {
  const { cluster } = await params;
  const query = await searchParams;
  const store = getStore();
  const c = store ? snapshotOf(store, cluster) : undefined;
  if (!c) notFound();
  const renderedAt = new Date().toISOString();
  const frame = { view: 'traffic', title: 'Traffic', cluster, traffic: true, renderedAt } as const;
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
  const layout = await layoutFlow(toFlow(g, { hidden: state.hidden, show: BOTH_KINDS, outside: c.traffic !== undefined }));
  const m = c.traffic && trafficModel(c.resources, c.traffic);
  const placed = m ? withExtraNodes(layout, extraFlowNodes(m)) : layout;
  const nodes = trafficNodes(placed.nodes, g);
  const compare = firstValue(query.compare) !== '0';
  // Every node drawn but the namespace boxes: the workloads by name, as What stands out names them, the
  // Internet, and the model's extra nodes by their labels.
  const workloadNames = readableNames(g.namespaces.flatMap((n) => n.workloads));
  const names = new Map(nodes.filter((n) => n.type !== 'namespace').map((n) => [n.id, workloadNames.get(n.id) ?? n.label]));
  const edges = m ? trafficEdges(m, { compare, visible: new Set(names.keys()), names }) : [];
  return (
    <Frame {...frame}>
      <div className="frame-body">
        <main className="page">
          <ClusterNote c={c} renderedAt={renderedAt} />
          {/* The comparison reads the policies, so the kinds netatlas may not read are named, as on the map. */}
          {cannotReadLines(c.resources).map((n) => (
            <p key={n} className="banner">
              {n}
            </p>
          ))}
          <TrafficToolbar namespaces={all.map((name) => ({ name, shown: !state.hidden.has(name) }))} compare={compare} />
          <TrafficNote note={trafficNote(cluster, c.traffic)} renderedAt={renderedAt} />
          <PolicyMap name={`Traffic map of ${cluster}`} flow={{ ...placed, nodes, edges }} hrefs={{}} highlighted={[]} />
          <TrafficLegend compare={compare} />
        </main>
        {m ? <StandsOut groups={m.standsOut} notes={m.notes} /> : null}
      </div>
    </Frame>
  );
}
