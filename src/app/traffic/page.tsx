import { ChooseCluster } from '@/components/frame/ChooseCluster';

export const dynamic = 'force-dynamic';

/** The traffic view shows one cluster at a time, so with All clusters chosen it asks for one. */
export default async function TrafficIndex() {
  return <ChooseCluster view="traffic" title="Traffic" ask="Choose a cluster to see its traffic." renderedAt={new Date().toISOString()} />;
}
