import type { TrafficPoll } from '@/model/traffic-status';
import type { ClusterResources } from '@/model/types';

/** What a source hands its sink. Later sources add members to this union rather than a new interface. */
export type SourceUpdate = { kind: 'resources'; resources: ClusterResources; at: Date } | { kind: 'traffic'; poll: TrafficPoll };

export interface SourceSink {
  update(u: SourceUpdate): void;
  /** The source stopped reading the cluster; the runner stops it and starts it again once the cluster answers. */
  lost(err: unknown): void;
}

export interface Source {
  /** The source's name in the server's log. */
  label: string;
  start(sink: SourceSink): Promise<void>;
  stop(): Promise<void>;
}
