import { OutboundView } from '@/components/outbound/OutboundView';
import { firstValue } from '@/model/flow';

export const dynamic = 'force-dynamic';

/** One cluster's destinations outside it. */
export default async function ClusterOutbound({ params, searchParams }: { params: Promise<{ cluster: string }>; searchParams: Promise<{ q?: string | string[] }> }) {
  const { cluster } = await params;
  const { q } = await searchParams;
  return <OutboundView cluster={cluster} query={firstValue(q) ?? ''} renderedAt={new Date().toISOString()} />;
}
