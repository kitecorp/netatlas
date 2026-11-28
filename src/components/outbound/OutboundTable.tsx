import { count } from '@/model/format';
import { mayCallGroups, type DoCall, type OutboundRow } from '@/model/outbound';
import { Destination } from './Destination';

/**
 * The workloads that may call the destination, those that share both verdicts as one group with the two
 * lines under it once, then how many more may.
 */
function MayCallCell({ row }: { row: OutboundRow }) {
  const groups = mayCallGroups(row.mayCall);
  return (
    <>
      {groups.length ? (
        <ul className="cell-lines">
          {groups.map((g) => (
            <li key={`${g.netpol}\n${g.istio}`} className="cell-may">
              {g.workloads.map((w) => (
                <span key={w} className="mono">
                  {w}
                </span>
              ))}
              {g.more > 0 ? <span className="cell-more">and {g.more} more</span> : null}
              <span className="cell-verdicts">
                <span>
                  <span className="line-text-networkpolicy">NetworkPolicy:</span> {g.netpol}
                </span>
                <span>
                  <span className="line-text-istio">Istio:</span> {g.istio}
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {row.othersMay > 0 ? <p className="cell-note">and {count(row.othersMay, 'other workload', 'other workloads')} that may call it</p> : null}
    </>
  );
}

/** Each workload that calls the destination with its figure, or `none` when figures exist and none called it. */
function DoCallCell({ calls, measured }: { calls: readonly DoCall[]; measured: boolean }) {
  if (!calls.length) return measured ? <span className="muted">none</span> : null;
  return (
    <ul className="cell-lines">
      {calls.map((d) => (
        <li key={d.workload} className="cell-call">
          <span className="mono">{d.workload}</span> <span className="mono">{d.text}</span>
        </li>
      ))}
    </ul>
  );
}

export interface OutboundTableProps {
  readonly cluster: string;
  readonly rows: readonly OutboundRow[];
  /** Whether the cluster's traffic source has given figures, so that an empty Do call cell means no calls. */
  readonly measured: boolean;
  /** Said under the Do call heading when the cluster has no traffic source. */
  readonly doCallNote?: string;
}

/**
 * A cluster's destinations outside it, as `outboundRows` gives them, in its order and words. Each row is named
 * by its destination. The table is wider than a phone, so its box scrolls sideways, and takes the focus so that
 * the keyboard can scroll it where a browser does not make a scroll box focusable by itself.
 */
export function OutboundTable({ cluster, rows, measured, doCallNote }: OutboundTableProps) {
  const name = `Destinations of ${cluster}`;
  return (
    <div className="table-box" role="region" aria-label={name} tabIndex={0}>
      <table className="table outbound-table" aria-label={name}>
        <thead>
          <tr>
            <th scope="col" className="col-destination">
              Destination
            </th>
            <th scope="col" className="col-ports">
              Ports
            </th>
            <th scope="col">May call</th>
            <th scope="col" className="col-do">
              Do call
              {doCallNote ? <span className="th-note">{doCallNote}</span> : null}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            // Per-caller rows share their destination text with others of their kind, and the table is drawn
            // anew on each render, so the row's place is its key.
            <tr key={i}>
              <th scope="row">
                <Destination kind={r.kind} text={r.destination} />
                {r.note ? <span className="cell-note">{r.note}</span> : null}
              </th>
              <td className="mono">{r.ports}</td>
              <td>
                <MayCallCell row={r} />
              </td>
              {/* The any row states a permission, not a destination: each call is on the row of where it went. Istio
                  records no address, so a call to an address range is never counted, and `none` would say nobody called it. */}
              <td>{r.kind === 'any' || r.kind === 'address-range' ? null : <DoCallCell calls={r.doCall} measured={measured} />}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
