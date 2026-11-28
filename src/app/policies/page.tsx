import { PoliciesView } from '@/components/policies/PoliciesView';
import { firstValue } from '@/model/flow';

export const dynamic = 'force-dynamic';

/** Every cluster's policies, grouped by cluster. */
export default async function Policies({ searchParams }: { searchParams: Promise<{ q?: string | string[] }> }) {
  const { q } = await searchParams;
  return <PoliciesView query={firstValue(q) ?? ''} renderedAt={new Date().toISOString()} />;
}
