import type { ReactNode } from 'react';
import { count } from '@/model/format';
import { CANNOT_READ, NO_ENFORCER, policyCountText, type OverviewRow } from '@/model/overview';
import { Age } from '../frame/Age';
import { LocalTime } from '../frame/LocalTime';

const mapHref = (name: string) => `/map/${encodeURIComponent(name)}`;

function NameCell({ name }: { name: string }) {
  return (
    <td className="name">
      <a href={mapHref(name)}>{name}</a>
    </td>
  );
}

/** What an unreachable cluster still shows: its last counts, marked with their age, or that nothing was ever read. */
function lastData(row: Extract<OverviewRow, { kind: 'unreachable' }>, age: (style: 'short' | 'long') => ReactNode): ReactNode {
  if (row.dataAt === null || row.policies === null) return 'No data yet.';
  const counts = [...(row.workloads === null ? [] : [count(row.workloads, 'workload', 'workloads')]), policyCountText(row.policies, 'sentence')].join(', ');
  return (
    <>
      Showing data from {age('long')}: {counts}.
    </>
  );
}

function Row({ row, renderedAt }: { row: OverviewRow; renderedAt: string }) {
  const age = (style: 'short' | 'long') => (row.kind === 'connecting' || row.dataAt === null ? null : <Age at={row.dataAt.toISOString()} renderedAt={renderedAt} style={style} />);
  switch (row.kind) {
    case 'connecting':
      return (
        <tr>
          <NameCell name={row.name} />
          <td colSpan={6} className="muted">
            Connecting
          </td>
          <td />
        </tr>
      );
    case 'unreachable':
      return (
        <tr className="row-down">
          <NameCell name={row.name} />
          <td colSpan={6}>
            Unreachable since <LocalTime iso={row.since.toISOString()} />: {row.reason}. {lastData(row, age)}
          </td>
          <td className="age">{age('short')}</td>
        </tr>
      );
    case 'reachable':
      return (
        <tr>
          <NameCell name={row.name} />
          <td>{row.kubernetes}</td>
          <td className="num">{row.workloads ?? CANNOT_READ}</td>
          <td className="num">{policyCountText(row.policies, 'cell')}</td>
          <td className={row.noPolicy ? 'num open-text' : 'num'}>{row.noPolicy ?? CANNOT_READ}</td>
          <td className={row.enforcer === NO_ENFORCER ? 'warn-text' : undefined}>{row.enforcer}</td>
          <td className={row.istio === 'none' || row.istio === CANNOT_READ ? 'muted' : undefined}>{row.istio}</td>
          {/* A reader starting again holds old data, which never reads as just updated. */}
          <td className="muted age">{row.reading ? <>reading, data from {age('short')}</> : age('short')}</td>
        </tr>
      );
  }
}

/** One row per cluster; a name opens the cluster's map. */
export function ClusterTable({ rows, renderedAt }: { rows: readonly OverviewRow[]; renderedAt: string }) {
  return (
    <section className="section" aria-labelledby="clusters-title">
      <h2 className="section-title" id="clusters-title">
        Clusters
      </h2>
      <div className="table-box">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Cluster</th>
              <th scope="col">Kubernetes</th>
              <th scope="col" className="num">
                Workloads
              </th>
              <th scope="col" className="num">
                Policies
              </th>
              <th scope="col" className="num">
                No policy
              </th>
              <th scope="col">Policies enforced by</th>
              <th scope="col">Istio</th>
              <th scope="col">Updated</th>
            </tr>
          </thead>
          <tbody>
            {rows.length ? (
              rows.map((r) => <Row key={r.name} row={r} renderedAt={renderedAt} />)
            ) : (
              <tr>
                <td colSpan={8} className="empty">
                  No cluster matches the search.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
