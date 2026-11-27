import type { ReactNode } from 'react';
import { ClusterNote } from '@/components/frame/ClusterNote';
import { Frame } from '@/components/frame/Frame';
import { LinkPicker } from '@/components/frame/LinkPicker';
import { compareText } from '@/model/classes';
import { policyHref } from '@/model/policies';
import type { ClusterSnapshot, PolicyRef } from '@/model/types';

/** The frame of one policy's page: the views, the header with the cluster and policy pickers (no search), and the cluster's note when it is not live. */
export function PolicyFrame({ c, current, renderedAt, children }: { c: ClusterSnapshot; current: PolicyRef; renderedAt: string; children: ReactNode }) {
  const r = c.resources;
  const refs: PolicyRef[] = r
    ? [
        ...r.networkPolicies.map((p) => ({ kind: 'NetworkPolicy' as const, namespace: p.metadata.namespace, name: p.metadata.name })),
        ...(r.authorizationPolicies === 'not-installed' ? [] : r.authorizationPolicies.map((p) => ({ kind: 'AuthorizationPolicy' as const, namespace: p.metadata.namespace, name: p.metadata.name }))),
      ].sort((a, b) => compareText(a.namespace, b.namespace) || compareText(a.name, b.name) || compareText(a.kind, b.kind))
    : [];
  const same = (a: PolicyRef) => a.kind === current.kind && a.namespace === current.namespace && a.name === current.name;
  const picker = (
    <LinkPicker
      plain
      summary={<span className="mono">{`${current.namespace} / ${current.name}`}</span>}
      menu="Policies"
      choices={refs.map((p) => ({ label: `${p.namespace} / ${p.name}`, href: policyHref(c.name, p), current: same(p) }))}
    />
  );
  return (
    <Frame view="policies" title="Policies" cluster={c.name} picker={picker} renderedAt={renderedAt}>
      <main className="page">
        <ClusterNote c={c} renderedAt={renderedAt} />
        {children}
      </main>
    </Frame>
  );
}
