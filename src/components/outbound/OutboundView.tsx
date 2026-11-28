import { notFound } from 'next/navigation';
import { ClusterNote, ClusterNotRead } from '@/components/frame/ClusterNote';
import { ClusterSection } from '@/components/frame/ClusterSection';
import { Frame } from '@/components/frame/Frame';
import { TrafficNote } from '@/components/traffic/TrafficNote';
import { cannotReadLines } from '@/model/cannot-read';
import { compareText } from '@/model/classes';
import { noDestinationText, outboundRows, searchOutboundRows } from '@/model/outbound';
import { trafficNote } from '@/model/traffic-status';
import type { ClusterSnapshot } from '@/model/types';
import { getStore } from '@/server/store';
import { snapshots } from '@/server/views';
import { OutboundTable } from './OutboundTable';

/**
 * One cluster's part of the page: why its data or figures may be old, the kinds netatlas may not read, whose
 * absence would otherwise read as none, then its destinations the search keeps.
 */
function ClusterPart({ c, query, renderedAt }: { c: ClusterSnapshot; query: string; renderedAt: string }) {
  if (!c.resources) return <ClusterNotRead c={c} renderedAt={renderedAt} />;
  const note = trafficNote(c.name, c.traffic);
  const all = outboundRows(c.resources, c.traffic);
  const rows = searchOutboundRows(all, query);
  const empty = all.length ? 'No destination matches the search.' : noDestinationText(c.resources);
  return (
    <>
      <ClusterNote c={c} renderedAt={renderedAt} />
      {cannotReadLines(c.resources).map((n) => (
        <p key={n} className="banner">
          {n}
        </p>
      ))}
      <TrafficNote note={note} renderedAt={renderedAt} />
      {rows.length ? (
        // Without figures no cell can say that nothing called, so the cells stay empty: the note above says
        // why, and for a cluster with no traffic source the column's header says it too.
        <OutboundTable cluster={c.name} rows={rows} measured={c.traffic?.figures !== undefined} {...(note.kind === 'none' ? { doCallNote: note.text } : {})} />
      ) : (
        empty !== undefined && <p className="empty">{empty}</p>
      )}
    </>
  );
}

/**
 * The Outbound view of one cluster, or of every cluster in name order; both pages render it. Each
 * traffic poll renders it again, and the search is the URL's `q`.
 */
export function OutboundView({ cluster, query, renderedAt }: { cluster?: string; query: string; renderedAt: string }) {
  const store = getStore();
  const clusters = store ? snapshots(store) : [];
  if (cluster !== undefined && !clusters.some((c) => c.name === cluster)) notFound();
  const shown = cluster === undefined ? [...clusters].sort((a, b) => compareText(a.name, b.name)) : clusters.filter((c) => c.name === cluster);
  return (
    <Frame
      view="outbound"
      title="Outbound"
      {...(cluster === undefined ? {} : { cluster })}
      traffic
      search={{ value: query, placeholder: 'workload or destination' }}
      renderedAt={renderedAt}
    >
      <main className="page">
        <p className="muted outbound-lead">What leaves {cluster ?? 'each cluster'}: what the policies allow out, and what Istio measured over the last 5 minutes.</p>
        {cluster === undefined
          ? shown.map((c) => (
              <ClusterSection key={c.name} cluster={c.name}>
                <ClusterPart c={c} query={query} renderedAt={renderedAt} />
              </ClusterSection>
            ))
          : shown.map((c) => <ClusterPart key={c.name} c={c} query={query} renderedAt={renderedAt} />)}
      </main>
    </Frame>
  );
}
