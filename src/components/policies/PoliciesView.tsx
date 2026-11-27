import { notFound } from 'next/navigation';
import { Frame } from '@/components/frame/Frame';
import { policyRows } from '@/model/policies';
import { getStore } from '@/server/store';
import { snapshots } from '@/server/views';
import { PolicyList } from './PolicyList';

/** The policy list of every cluster, or of one; both pages render it. The search is the URL's `q`. */
export function PoliciesView({ cluster, query, renderedAt }: { cluster?: string; query: string; renderedAt: string }) {
  const store = getStore();
  const clusters = store ? snapshots(store) : [];
  if (cluster !== undefined && !clusters.some((c) => c.name === cluster)) notFound();
  const byName = new Map(clusters.map((c) => [c.name, c]));
  const groups = policyRows(clusters, { ...(cluster === undefined ? {} : { cluster }), query }).flatMap((g) => {
    const c = byName.get(g.cluster);
    return c ? [{ ...g, snapshot: c }] : [];
  });
  return (
    <Frame view="policies" title="Policies" {...(cluster === undefined ? {} : { cluster })} search={{ value: query, placeholder: 'workload, label or policy' }} renderedAt={renderedAt}>
      <main className="page">
        <PolicyList groups={groups} renderedAt={renderedAt} />
      </main>
    </Frame>
  );
}
