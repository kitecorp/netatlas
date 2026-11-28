import { reduceTraffic } from '@/model/traffic-status';
import { messageOf } from './message-of';
import type { SourceSink } from './sources/source';
import type { Store } from './store';

/**
 * The sink of a cluster's traffic source: it moves the cluster's traffic in the store, and nothing
 * else, so the cluster's own status never moves with a poll, and the pages that do not show traffic
 * move only when the source starts or stops answering.
 */
export function trafficSink(store: Store, name: string): SourceSink {
  return {
    update(u) {
      const traffic = store.clusters.get(name)?.traffic;
      if (u.kind === 'traffic' && traffic) store.updateTraffic(name, reduceTraffic(traffic, u.poll));
    },
    // The traffic source keeps polling through every failure and never reports itself lost.
    lost(err) {
      console.warn(`netatlas: traffic for ${name} stopped: ${messageOf(err)}`);
    },
  };
}
