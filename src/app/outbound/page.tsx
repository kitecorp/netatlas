import { OutboundView } from '@/components/outbound/OutboundView';
import { firstValue } from '@/model/flow';

export const dynamic = 'force-dynamic';

/** Every cluster's destinations outside it, grouped by cluster. */
export default async function Outbound({ searchParams }: { searchParams: Promise<{ q?: string | string[] }> }) {
  const { q } = await searchParams;
  return <OutboundView query={firstValue(q) ?? ''} renderedAt={new Date().toISOString()} />;
}
