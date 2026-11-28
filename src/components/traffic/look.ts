import type { TrafficMark } from '@/model/traffic';

/** How a traffic edge is drawn: its line, its label's colour, and its dashes (solid without). */
export interface EdgeLook {
  readonly line: string;
  readonly text: string;
  readonly dash?: string;
}

const IDLE: EdgeLook = { line: '#9fb0c8', text: '#c3cfe0', dash: '1 7' };
/** An edge the policies were not compared with. */
const GREY: EdgeLook = { line: '#7f93b2', text: '#c3cfe0' };

/**
 * The look of each mark, and `seen`, every edge's look while the comparison is off. One table serves the
 * edges, their arrowheads and the legend, so the three never disagree. The colours are written out, not
 * CSS variables, because React Flow builds each arrowhead's id from its colour.
 */
export const TRAFFIC_LOOK: Readonly<Record<TrafficMark | 'seen', EdgeLook>> = {
  seen: { line: '#5fd3c4', text: '#8fe3d8' },
  allowed: { line: '#5fd3c4', text: '#8fe3d8' },
  uncovered: { line: '#ffb3bd', text: '#ffb3bd', dash: '6 6' },
  // Both say "allowed by a policy, no traffic seen"; the label tells 24 hours from 5 minutes.
  unused: IDLE,
  quiet: IDLE,
  'refused-istio': { line: '#ffb454', text: '#ffc97a', dash: '12 4' },
  'refused-network': { line: '#ff7b72', text: '#ffa198', dash: '12 4' },
  'answered-denied': { line: '#d2a8ff', text: '#e2c5ff' },
  outbound: { line: '#6cb6ff', text: '#9ccbff' },
  'not-evaluated': GREY,
  // Allowed and idle, so dotted as an idle edge, but grey: nothing was measured to compare.
  'not-measured': { ...GREY, dash: IDLE.dash },
};
