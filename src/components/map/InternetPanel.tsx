import { FocusHeading } from '@/components/frame/FocusHeading';
import { Destination } from '@/components/outbound/Destination';
import { TrafficNote } from '@/components/traffic/TrafficNote';
import { count } from '@/model/format';
import type { ShortList } from '@/model/outbound';
import type { TrafficNote as Note } from '@/model/traffic-status';

export interface InternetPanelProps {
  readonly cluster: string;
  readonly list: ShortList;
  readonly note: Note;
  /** Whether the cluster's traffic source has given figures; without them there is no list to show. */
  readonly measured: boolean;
  readonly renderedAt: string;
}

/**
 * The side panel of the map's Internet node: the short form of the Outbound view, with the destinations
 * called most, how many destinations the policies name, and the way to the whole view.
 */
export function InternetPanel({ cluster, list, note, measured, renderedAt }: InternetPanelProps) {
  return (
    <section className="side" aria-labelledby="internet-title">
      <FocusHeading className="panel-title" id="internet-title">
        Outside the cluster
      </FocusHeading>
      <TrafficNote note={note} renderedAt={renderedAt} />
      {measured ? (
        <section className="panel-section" aria-labelledby="internet-top">
          <h3 className="section-title" id="internet-top">
            Most called, last 5 minutes
          </h3>
          {list.top.length ? (
            <ol className="panel-lines internet-list">
              {list.top.map((t) => (
                // The short list has one entry per destination text.
                <li key={t.destination}>
                  <Destination kind={t.kind} text={t.destination} /> <span className="mono">{t.text}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="empty">None.</p>
          )}
        </section>
      ) : null}
      <p className="panel-summary">{count(list.named, 'destination', 'destinations')} named by the policies</p>
      <a className="button button-link internet-link" href={`/outbound/${encodeURIComponent(cluster)}`}>
        Open the Outbound view
      </a>
    </section>
  );
}
