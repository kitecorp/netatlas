import { TRAFFIC_LEGEND } from '@/model/traffic-flow';
import { TRAFFIC_LOOK, type EdgeLook } from './look';

function Line({ look, text }: { look: EdgeLook; text: string }) {
  return (
    <span className="dot-line">
      <svg aria-hidden="true" width="28" height="8" viewBox="0 0 28 8" className="line-traffic">
        <path d="M1 4 L27 4" style={{ stroke: look.line, ...(look.dash ? { strokeDasharray: look.dash } : {}) }} />
      </svg>
      {text}
    </span>
  );
}

/** What the traffic edges mean: one line per mark with the comparison on, and one look for every edge with it off. */
export function TrafficLegend({ compare }: { compare: boolean }) {
  return (
    <div className="map-legend">
      {compare ? TRAFFIC_LEGEND.map((l) => <Line key={l.mark} look={TRAFFIC_LOOK[l.mark]} text={l.text} />) : <Line look={TRAFFIC_LOOK.seen} text="traffic seen" />}
    </div>
  );
}
