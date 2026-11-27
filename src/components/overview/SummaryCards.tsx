import { totalNote, type OverviewTotals } from '@/model/overview';

/** The four cards above the cluster table. Workloads, policies and open workloads count the reachable clusters only. */
export function SummaryCards({ totals }: { totals: OverviewTotals }) {
  const reachable = totals.clusters - totals.unreachable;
  return (
    <div className="cards">
      <div className="card">
        <span className="card-label">Clusters</span>
        <b className="card-value">{totals.clusters}</b>
        <span className={totals.unreachable ? 'card-note open-text' : 'card-note'}>{totals.unreachable ? `${totals.unreachable} unreachable` : 'all reachable'}</span>
      </div>
      <div className="card">
        <span className="card-label">Workloads</span>
        <b className="card-value">{totals.workloads.value}</b>
        <span className="card-note">{totalNote(totals.workloads, `in the ${reachable} reachable`)}</span>
      </div>
      <div className="card">
        <span className="card-label">Policies</span>
        <b className="card-value">{totals.policies.value}</b>
        <span className="card-note">{totalNote(totals.policies, 'NetworkPolicy and Istio')}</span>
      </div>
      <div className="card card-open">
        <span className="card-label">No policy</span>
        <b className="card-value">{totals.noPolicy.value}</b>
        <span className="card-note">{totalNote(totals.noPolicy, 'workloads open both ways')}</span>
      </div>
    </div>
  );
}
