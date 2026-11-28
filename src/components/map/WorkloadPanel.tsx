import { FocusHeading } from '@/components/frame/FocusHeading';
import { count, POLICY_KIND_TEXT } from '@/model/format';
import type { DetailLine, WorkloadDetail, WorkloadNode } from '@/model/graph';
import { policyHref } from '@/model/policies';

function Lines({ id, title, lines }: { id: string; title: string; lines: readonly DetailLine[] }) {
  return (
    <section className="panel-section" aria-labelledby={id}>
      <h3 className="section-title" id={id}>
        {title}
      </h3>
      {lines.length ? (
        <ul className="panel-lines">
          {lines.map((l, i) => (
            <li key={`${l.peer}-${l.kind}-${l.label}-${i}`}>
              <span>
                {l.peer}
                {l.note ? <span className="panel-note"> ({l.note})</span> : null}
              </span>
              <span className={`mono line-text-${l.kind}`}>{l.label}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty">None.</p>
      )}
    </section>
  );
}

/** The side panel of one workload: the policies that select it, what may call it, what it may call, what its egress keeps it from, and the summary. */
export function WorkloadPanel({ cluster, node, detail }: { cluster: string; node: WorkloadNode; detail: WorkloadDetail }) {
  const n = detail.selectedBy.length;
  return (
    <aside className="side" aria-labelledby="panel-title">
      <div className="panel-head">
        <div className="nav-sub">namespace {node.namespace}</div>
        <FocusHeading className="panel-title" id="panel-title">
          {node.name}
        </FocusHeading>
        <div className="muted">
          {node.kind} · {count(node.pods, 'pod', 'pods')}
          {node.istioNotEnforced ? ' · Istio not enforced' : ''}
        </div>
      </div>
      <section className="panel-section" aria-labelledby="panel-policies">
        <h3 className="section-title" id="panel-policies">
          {n ? `Selected by ${count(n, 'policy', 'policies')}` : 'Selected by no policy'}
        </h3>
        {detail.selectedBy.map((r) => (
          <a key={`${r.kind}/${r.namespace}/${r.name}`} className="panel-policy" href={policyHref(cluster, r)}>
            <span className="mono">{r.name}</span>
            <span className={r.kind === 'NetworkPolicy' ? 'line-text-networkpolicy' : 'line-text-istio'}>{POLICY_KIND_TEXT[r.kind]}</span>
          </a>
        ))}
      </section>
      <Lines id="panel-callers" title="May call it" lines={detail.mayCallIt} />
      <Lines id="panel-calls" title="It may call" lines={detail.itMayCall} />
      {/* Only a workload its egress keeps from istiod or kube-dns has anything to say here. */}
      {detail.needs.length ? (
        <section className="panel-section" aria-labelledby="panel-needs">
          <h3 className="section-title" id="panel-needs">
            Egress the mesh needs
          </h3>
          <ul className="panel-lines">
            {detail.needs.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      ) : null}
      <p className="muted panel-summary">{detail.summary}</p>
    </aside>
  );
}
