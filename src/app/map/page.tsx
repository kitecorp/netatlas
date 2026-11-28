import { ChooseCluster } from '@/components/frame/ChooseCluster';

export const dynamic = 'force-dynamic';

/** The map shows one cluster at a time, so with All clusters chosen it asks for one. */
export default async function MapIndex() {
  return <ChooseCluster view="map" title="Policy map" ask="Choose a cluster to see its map." search={{ value: '', placeholder: 'workload or policy' }} renderedAt={new Date().toISOString()} />;
}
