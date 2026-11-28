export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Two rectangles touch when they share more than an edge. */
const touch = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** For each label in order: the first candidate whose rectangle, centred on it, touches no box and no label placed before it; the first candidate when none is free. */
export function labelSpots(labels: readonly { readonly candidates: readonly Point[]; readonly width: number; readonly height: number }[], boxes: readonly Rect[]): Point[] {
  const placed: Rect[] = [];
  return labels.map(({ candidates, width, height }) => {
    const rectAt = (p: Point): Rect => ({ x: p.x - width / 2, y: p.y - height / 2, width, height });
    const isFree = (p: Point) => {
      const r = rectAt(p);
      return !boxes.some((b) => touch(r, b)) && !placed.some((b) => touch(r, b));
    };
    const spot = candidates.find(isFree) ?? candidates[0];
    if (!spot) throw new Error('labelSpots: a label needs at least one candidate');
    // A label left at its first candidate is drawn there too, so it takes its room all the same.
    placed.push(rectAt(spot));
    return spot;
  });
}
