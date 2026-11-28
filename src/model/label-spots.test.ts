import { expect, it } from 'vitest';
import { labelSpots, type Point, type Rect } from './label-spots';

type Label = { candidates: Point[]; width: number; height: number };

/** A 40 by 10 label: its rectangle reaches 20 to each side of its spot and 5 above and below. */
const label = (...candidates: Point[]): Label => ({ candidates, width: 40, height: 10 });
const at = (x: number, y: number): Point => ({ x, y });

/** A box from x 100 to 150 and y 0 to 50. */
const BOX: Rect = { x: 100, y: 0, width: 50, height: 50 };

it.each<[string, Label[], Rect[], Point[]]>([
  ['no box and no label before it: the first candidate', [label(at(10, 10), at(90, 90))], [], [at(10, 10)]],
  // At x 81 the rectangle reaches 101, one into the box; at x 80 it reaches 100, the box's left edge.
  ['one into a box from the side touches it, its edge alone does not', [label(at(81, 25), at(80, 25))], [BOX], [at(80, 25)]],
  // At y 54 the rectangle starts at 49, one into the box; at y 55 it starts at 50, the box's bottom edge.
  ['one into a box from below touches it, its edge alone does not', [label(at(125, 54), at(125, 55))], [BOX], [at(125, 55)]],
  // The candidates of an edge 400 long, at 50, 35, 65, 20 and 80 percent of it; the box covers the first four.
  ['every candidate is tried in turn: the fifth when the first four touch a box', [label(at(200, 50), at(140, 50), at(260, 50), at(80, 50), at(320, 50))], [{ x: 60, y: 40, width: 220, height: 20 }], [at(320, 50)]],
  ['a label placed before takes its spot: the next label goes to its next candidate', [label(at(200, 100), at(200, 200)), label(at(210, 100), at(300, 100))], [], [at(200, 100), at(300, 100)]],
  // The same two labels the other way round.
  ['the label given first keeps its spot', [label(at(210, 100), at(300, 100)), label(at(200, 100), at(200, 200))], [], [at(210, 100), at(200, 200)]],
  // The second label is 10 wide: at x 225 it reaches 220, where the first one ends.
  ['each label is measured by its own size: one that only shares an edge with a label before it stays', [label(at(200, 100)), { candidates: [at(225, 100), at(300, 100)], width: 10, height: 10 }], [], [at(200, 100), at(225, 100)]],
  ['no candidate is free: the first candidate', [label(at(100, 100), at(500, 500))], [{ x: 0, y: 0, width: 1000, height: 1000 }], [at(100, 100)]],
  // The first label touches the box at both candidates, so it stays at the first, reaching x 30 to 70;
  // at x 20 the second reaches 40, the box's edge, and overlaps the first label from 30 to 40.
  ['a label left at its first candidate still counts as placed', [label(at(50, 50), at(50, 52)), label(at(20, 50), at(20, 200))], [{ x: 40, y: 40, width: 20, height: 20 }], [at(50, 50), at(20, 200)]],
  ['no labels: no spots', [], [BOX], []],
])('places each label at its first free spot %#: %s', (_name, labels, boxes, expected) => {
  expect(labelSpots(labels, boxes)).toStrictEqual(expected);
});
