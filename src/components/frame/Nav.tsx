import type { ReactNode } from 'react';
import type { FrameData } from '@/server/views';

export type View = 'overview' | 'map' | 'policies' | 'traffic' | 'outbound';

export interface NavProps {
  readonly view: View;
  /** The cluster the page shows, which the views that show one cluster at a time open. */
  readonly cluster?: string;
  readonly clusters: number;
  readonly reachable: number;
  readonly trafficSources: FrameData['trafficSources'];
}

const href = (view: View, cluster?: string) => (view === 'overview' ? '/' : cluster ? `/${view}/${encodeURIComponent(cluster)}` : `/${view}`);

/** A data source's line: a filled dot while any of its sources answers, an empty ring otherwise. */
function Source({ live, children }: { live: boolean; children: ReactNode }) {
  return (
    <div className="dot-line">
      <svg aria-hidden="true" width="8" height="8" viewBox="0 0 8 8">
        {live ? <circle cx="4" cy="4" r="4" fill="var(--ok)" /> : <circle cx="4" cy="4" r="3.25" fill="none" stroke="var(--muted)" strokeWidth="1.5" />}
      </svg>
      {children}
    </div>
  );
}

/** The views column: the views, and where the data comes from. */
export function Nav({ view, cluster, clusters, reachable, trafficSources }: NavProps) {
  const link = (to: View, label: string) => (
    <a className="nav-link" href={href(to, cluster)} aria-current={to === view ? 'page' : undefined}>
      {label}
    </a>
  );
  return (
    <nav aria-label="Views" className="nav">
      <div className="nav-brand">
        <div className="nav-name">netatlas</div>
        <div className="nav-sub">{cluster ? `cluster ${cluster}` : `${clusters} ${clusters === 1 ? 'cluster' : 'clusters'}`}</div>
      </div>
      <div className="nav-links">
        {link('overview', 'Overview')}
        <div className="nav-group">Network</div>
        {link('map', 'Policy map')}
        {link('policies', 'Policies')}
        {link('traffic', 'Traffic')}
        {link('outbound', 'Outbound')}
      </div>
      <div className="nav-sources">
        <div className="eyebrow">Data sources</div>
        <Source live={reachable > 0}>
          Kubernetes API, {reachable} of {clusters}
        </Source>
        {trafficSources ? <Source live={trafficSources.live}>{trafficSources.label}</Source> : null}
      </div>
    </nav>
  );
}

/** The picker's choices: All clusters, then each cluster, opening the same view for it. */
export function clusterChoices(view: View, names: readonly string[], current?: string) {
  return [
    { label: 'All clusters', href: href(view), current: current === undefined },
    ...names.map((name) => ({ label: name, href: href(view === 'overview' ? 'map' : view, name), current: name === current })),
  ];
}
