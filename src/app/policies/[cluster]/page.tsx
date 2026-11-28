import { PoliciesView } from '@/components/policies/PoliciesView';
import { firstValue } from '@/model/flow';

export const dynamic = 'force-dynamic';

/** One cluster's policies. */
export default async function ClusterPolicies({ params, searchParams }: { params: Promise<{ cluster: string }>; searchParams: Promise<{ q?: string | string[] }> }) {
  const { cluster } = await params;
  const { q } = await searchParams;
  return <PoliciesView cluster={cluster} query={firstValue(q) ?? ''} renderedAt={new Date().toISOString()} />;
}
