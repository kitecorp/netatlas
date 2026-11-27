import { notFound } from 'next/navigation';
import { Editor } from '@/components/editor/Editor';
import { PolicyFrame } from '@/components/policies/PolicyFrame';
import { coverage, missingPolicyText } from '@/model/policies';
import { getStore } from '@/server/store';
import { snapshotOf, tokenHint } from '@/server/views';

export const dynamic = 'force-dynamic';

/** The editor of one NetworkPolicy, as the cluster has it now. */
export default async function NetworkPolicyPage({ params }: { params: Promise<{ cluster: string; namespace: string; name: string }> }) {
  const { cluster, namespace, name } = await params;
  const store = getStore();
  const entry = store?.clusters.get(cluster);
  const c = store ? snapshotOf(store, cluster) : undefined;
  if (!entry || !c) notFound();
  const r = c.resources;
  const policy = r?.networkPolicies.find((p) => p.metadata.namespace === namespace && p.metadata.name === name);
  return (
    <PolicyFrame c={c} renderedAt={new Date().toISOString()} current={{ kind: 'NetworkPolicy', namespace, name }}>
      {r && policy ? (
        <Editor cluster={cluster} policy={policy} coverage={coverage(policy, r)} tokenHint={tokenHint(entry.config)} reachable={c.status.state === 'reachable'} />
      ) : (
        <p className="empty">{missingPolicyText(cluster, r, 'NetworkPolicy')}</p>
      )}
    </PolicyFrame>
  );
}
