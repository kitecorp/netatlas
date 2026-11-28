import { Age } from '@/components/frame/Age';
import { LocalTime } from '@/components/frame/LocalTime';
import type { TrafficNote as Note } from '@/model/traffic-status';

/**
 * What a page says about a cluster's traffic source while its figures are not live: that it has none,
 * that it is reading, or since when and why Prometheus does not answer, with the age of the figures
 * still shown. Nothing while the figures are live.
 */
export function TrafficNote({ note, renderedAt }: { note: Note; renderedAt: string }) {
  switch (note.kind) {
    case 'none':
      return <p className="banner">{note.text}</p>;
    case 'reading':
      return <p className="banner">Reading traffic from Prometheus.</p>;
    case 'unavailable':
      return (
        <p className="banner banner-open">
          Traffic unavailable since <LocalTime iso={note.since.toISOString()} />: {note.reason}.{' '}
          {note.figuresAt ? (
            <>
              Showing figures from <Age at={note.figuresAt.toISOString()} renderedAt={renderedAt} style="long" />.
            </>
          ) : (
            'No figures yet.'
          )}
        </p>
      );
    case 'live':
      return null;
  }
}
