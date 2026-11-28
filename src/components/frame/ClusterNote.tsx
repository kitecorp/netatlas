import { notReadYet } from '@/model/format';
import { freshness } from '@/model/freshness';
import type { ClusterSnapshot } from '@/model/types';
import { Age } from './Age';
import { LocalTime } from './LocalTime';

/**
 * What a cluster's data is worth while it is not live: since when and why it does not answer, or that
 * its reader is starting again, and how old the data shown is. Nothing while the cluster is live.
 */
export function ClusterNote({ c, renderedAt }: { c: ClusterSnapshot; renderedAt: string }) {
  const f = freshness(c);
  const age = f.kind === 'none' ? null : <Age at={f.at.toISOString()} renderedAt={renderedAt} style="long" />;
  if (c.status.state === 'unreachable') {
    return (
      <p className="banner banner-open">
        Unreachable since <LocalTime iso={c.status.since.toISOString()} />: {c.status.reason}. {age ? <>Showing data from {age}.</> : 'No data yet.'}
      </p>
    );
  }
  if (f.kind !== 'reading' || !age) return null;
  return (
    <p className="banner">
      netatlas is reading {c.name} again. Showing data from {age}.
    </p>
  );
}

/** What a page of one cluster shows before netatlas has read it once: why it cannot reach it, or that it has not read it yet. */
export function ClusterNotRead({ c, renderedAt }: { c: ClusterSnapshot; renderedAt: string }) {
  return c.status.state === 'unreachable' ? <ClusterNote c={c} renderedAt={renderedAt} /> : <p className="empty">{notReadYet(c.name)}</p>;
}
