import type { ReactNode } from 'react';

/** One cluster's part of a page that lists every cluster, named by its heading, so that each part is a region of the page. */
export function ClusterSection({ cluster, children }: { cluster: string; children: ReactNode }) {
  return (
    <section className="section" aria-labelledby={`cluster-${cluster}`}>
      <h2 className="cluster-title" id={`cluster-${cluster}`}>
        {cluster}
      </h2>
      {children}
    </section>
  );
}
