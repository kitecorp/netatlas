export type View = 'overview' | 'map' | 'policies';

export interface NavProps {
  readonly view: View;
  /** The cluster the page shows, which the views that show one cluster at a time open. */
  readonly cluster?: string;
  readonly clusters: number;
  readonly reachable: number;
}

const href = (view: View, cluster?: string) => (view === 'overview' ? '/' : cluster ? `/${view}/${encodeURIComponent(cluster)}` : `/${view}`);

/** The views column: the views, and where the data comes from. */
export function Nav({ view, cluster, clusters, reachable }: NavProps) {
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
      </div>
      <div className="nav-sources">
        <div className="eyebrow">Data sources</div>
        <div className="dot-line">
          <svg aria-hidden="true" width="8" height="8" viewBox="0 0 8 8">
            {reachable > 0 ? <circle cx="4" cy="4" r="4" fill="var(--ok)" /> : <circle cx="4" cy="4" r="3.25" fill="none" stroke="var(--muted)" strokeWidth="1.5" />}
          </svg>
          Kubernetes API, {reachable} of {clusters}
        </div>
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
