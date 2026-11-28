import { ClusterNote } from '@/components/frame/ClusterNote';
import { ClusterSection } from '@/components/frame/ClusterSection';
import { count, POLICY_KIND_TEXT } from '@/model/format';
import type { PolicyGroupRows } from '@/model/policies';
import type { ClusterSnapshot } from '@/model/types';

export interface PolicyGroup extends PolicyGroupRows {
  readonly snapshot: ClusterSnapshot;
}

/**
 * The policies of each cluster, one table per cluster in the registry's order; a name opens the policy.
 * A cluster that is not live says how old its data is, and a kind netatlas may not read says so.
 */
export function PolicyList({ groups, renderedAt }: { groups: readonly PolicyGroup[]; renderedAt: string }) {
  return (
    <>
      {groups.map((g) => (
        <ClusterSection key={g.cluster} cluster={g.cluster}>
          <ClusterNote c={g.snapshot} renderedAt={renderedAt} />
          {g.cannotRead.map((line) => (
            <p key={line} className="banner">
              {line}
            </p>
          ))}
          {g.rows.length ? (
            <div className="table-box">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Policy</th>
                    <th scope="col">Namespace</th>
                    <th scope="col">Kind</th>
                    <th scope="col">Covers</th>
                  </tr>
                </thead>
                <tbody>
                  {g.rows.map((r) => (
                    <tr key={r.href}>
                      <td className="name">
                        <a href={r.href}>{r.name}</a>
                      </td>
                      <td className="mono">{r.namespace}</td>
                      <td className={r.kind === 'NetworkPolicy' ? 'line-text-networkpolicy' : 'line-text-istio'}>{POLICY_KIND_TEXT[r.kind]}</td>
                      <td>
                        <span title={r.covers.join(', ')}>covers {count(r.covers.length, 'workload', 'workloads')}</span>
                        {r.notes.map((n) => (
                          <span key={n} className="panel-note warn-text">
                            {' '}
                            · {n}
                          </span>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : g.empty ? (
            <p className="empty">{g.empty}</p>
          ) : null}
        </ClusterSection>
      ))}
    </>
  );
}
