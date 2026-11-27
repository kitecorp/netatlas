import { PoliciesView } from '@/components/policies/PoliciesView';

export const dynamic = 'force-dynamic';

/** Every cluster's policies, grouped by cluster. */
export default async function Policies({ searchParams }: { searchParams: Promise<{ q?: string | string[] }> }) {
  const { q } = await searchParams;
  return <PoliciesView query={typeof q === 'string' ? q : ''} renderedAt={new Date().toISOString()} />;
}
