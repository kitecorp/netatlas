import type { ReactNode } from 'react';
import { allClustersLabel, clusterLabel } from '@/model/freshness';
import { getStore } from '@/server/store';
import { frameOf, snapshotOf } from '@/server/views';
import { Header } from './Header';
import { clusterChoices, Nav, type View } from './Nav';

export interface FrameProps {
  readonly view: View;
  readonly title: string;
  /** The cluster the page shows; every cluster when absent. */
  readonly cluster?: string;
  readonly search?: { readonly value: string; readonly placeholder: string };
  /** Controls after the cluster picker, such as the policy picker. */
  readonly picker?: ReactNode;
  /** When the server rendered the page, which every age on it counts from. */
  readonly renderedAt: string;
  readonly children: ReactNode;
}

/** Every page's frame: the views column, the header with the cluster picker, the search and the live status. */
export function Frame({ view, title, cluster, search, picker, renderedAt, children }: FrameProps) {
  const store = getStore();
  const { names, reachable } = frameOf(store);
  const c = cluster === undefined || !store ? undefined : snapshotOf(store, cluster);
  const label = c ? clusterLabel(c) : allClustersLabel(reachable, names.length);
  const live = {
    ...(cluster === undefined ? {} : { cluster }),
    state: label.state,
    ...(label.age ? { age: { lead: label.age.lead, at: label.age.at.toISOString() } } : {}),
    renderedAt,
  };
  return (
    <div className="frame">
      <Nav view={view} {...(cluster === undefined ? {} : { cluster })} clusters={names.length} reachable={reachable} />
      <div className="frame-main">
        <Header title={title} cluster={cluster ?? 'All clusters'} choices={clusterChoices(view, names, cluster)} {...(search ? { search } : {})} live={live}>
          {picker}
        </Header>
        {children}
      </div>
    </div>
  );
}
