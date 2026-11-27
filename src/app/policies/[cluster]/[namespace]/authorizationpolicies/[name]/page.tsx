import { notFound } from 'next/navigation';
import { PolicyFrame } from '@/components/policies/PolicyFrame';
import { forDisplay, toYaml } from '@/editor/yaml';
import { missingPolicyText } from '@/model/policies';
import { getStore } from '@/server/store';
import { snapshotOf } from '@/server/views';

export const dynamic = 'force-dynamic';

/** An Istio AuthorizationPolicy: shown as its YAML, never edited here. */
export default async function AuthorizationPolicyPage({ params }: { params: Promise<{ cluster: string; namespace: string; name: string }> }) {
  const { cluster, namespace, name } = await params;
  const store = getStore();
  const c = store ? snapshotOf(store, cluster) : undefined;
  if (!c) notFound();
  const r = c.resources;
  const policies = r && r.authorizationPolicies !== 'not-installed' ? r.authorizationPolicies : [];
  const policy = policies.find((p) => p.metadata.namespace === namespace && p.metadata.name === name);
  return (
    <PolicyFrame c={c} renderedAt={new Date().toISOString()} current={{ kind: 'AuthorizationPolicy', namespace, name }}>
      {policy ? (
        <section className="yaml-pane" aria-labelledby="policy-title">
          <div className="coverage-kind">Istio AuthorizationPolicy · namespace {namespace}</div>
          <h2 className="editor-title" id="policy-title">
            {name}
          </h2>
          <p className="muted">Shown, not edited here.</p>
          <pre className="yaml">{toYaml(forDisplay(policy))}</pre>
        </section>
      ) : (
        <p className="empty">{missingPolicyText(cluster, r, 'AuthorizationPolicy')}</p>
      )}
    </PolicyFrame>
  );
}
