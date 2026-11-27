import { Frame } from '@/components/frame/Frame';
import { ClusterTable } from '@/components/overview/ClusterTable';
import { NeedsAttention } from '@/components/overview/NeedsAttention';
import { SummaryCards } from '@/components/overview/SummaryCards';
import { matchesSearch, needsAttention, overviewRows, overviewTotals } from '@/model/overview';
import { getStore } from '@/server/store';
import { snapshots } from '@/server/views';

// The store changes after the build, so the page renders on every request.
export const dynamic = 'force-dynamic';

/** The overview: every cluster at once. The search narrows the table; the cards and the attention list count every cluster. */
export default async function Overview({ searchParams }: { searchParams: Promise<{ q?: string | string[] }> }) {
  const { q } = await searchParams;
  const query = typeof q === 'string' ? q : '';
  const store = getStore();
  const clusters = store ? snapshots(store) : [];
  const rows = overviewRows(clusters);
  const shown = new Set(clusters.filter((c) => matchesSearch(c, query)).map((c) => c.name));
  const renderedAt = new Date().toISOString();
  return (
    <Frame view="overview" title="Overview" search={{ value: query, placeholder: 'cluster, workload or policy' }} renderedAt={renderedAt}>
      <div className="frame-body">
        <main className="page">
          <SummaryCards totals={overviewTotals(rows)} />
          <ClusterTable rows={rows.filter((r) => shown.has(r.name))} renderedAt={renderedAt} />
        </main>
        <NeedsAttention items={needsAttention(rows)} />
      </div>
    </Frame>
  );
}
