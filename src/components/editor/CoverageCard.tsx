import type { Coverage } from '@/model/policies';
import { policyHref } from '@/model/policies';

/** The middle of the editor: the policy, what its selector says, the pods it covers now, and who else covers them. */
export function CoverageCard({ cluster, kind, namespace, name, coverage }: { cluster: string; kind: string; namespace: string; name: string; coverage: Coverage }) {
  const others = coverage.alsoCoveredBy;
  return (
    <div className="coverage">
      <div className="coverage-head">
        <div className="coverage-kind">
          {kind} · namespace {namespace}
        </div>
        <b className="coverage-name">{name}</b>
      </div>
      <div className="coverage-part">
        <div className="muted">{coverage.chips.length ? `Covers every pod in ${namespace} that has` : `Covers every pod in ${namespace}`}</div>
        {coverage.chips.length ? (
          <div className="chips">
            {coverage.chips.map((c) => (
              <span key={c} className="chip mono">
                {c}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <div className="coverage-part coverage-divided">
        <b>{coverage.matchLine}</b>
        {coverage.pods.length ? <span className="coverage-pods mono">{coverage.pods.join('\n')}</span> : null}
        {coverage.workloadsLine ? <span className="coverage-note">{coverage.workloadsLine}</span> : null}
      </div>
      {others.length ? (
        <div className="coverage-note coverage-divided">
          Also covered by{' '}
          {others.map((r, i) => (
            <span key={`${r.kind}/${r.name}`}>
              {i > 0 ? ', ' : null}
              <a href={policyHref(cluster, r)}>{r.name}</a>
              {r.kind === 'AuthorizationPolicy' ? ' (Istio, shown, not edited here)' : null}
            </span>
          ))}
          .
        </div>
      ) : null}
    </div>
  );
}
