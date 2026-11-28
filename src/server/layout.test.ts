import { describe, expect, it } from 'vitest';
import { SHOP } from '@/model/fixtures/shop';
import { toFlow, type FlowNode } from '@/model/flow';
import { clusterGraph, defaultHidden } from '@/model/graph';
import { layoutFlow, withExtraNodes, type PositionedFlow, type PositionedNode } from './layout';

const shop = () => layoutFlow(toFlow(clusterGraph(SHOP), { hidden: defaultHidden(SHOP), show: { networkpolicy: true, istio: true } }));

/** A child's position is relative to its namespace box, as React Flow reads it. */
const inside = (child: PositionedNode, parent: PositionedNode) => child.x >= 0 && child.y >= 0 && child.x + child.width <= parent.width && child.y + child.height <= parent.height;

describe('layoutFlow', () => {
  it("keeps toFlow's order and gives every workload and the Internet a 176 x 64 box", async () => {
    const f = await shop();

    expect(f.nodes.filter((n) => n.type !== 'namespace').map((n) => [n.id, n.width, n.height])).toStrictEqual([
      ['ingress/Deployment/gateway', 176, 64],
      ['payments/Deployment/api', 176, 64],
      ['payments/Deployment/postgres', 176, 64],
      ['shop/Deployment/cart', 176, 64],
      ['shop/Deployment/frontend', 176, 64],
      ['shop/Deployment/recommender', 176, 64],
      ['outside', 176, 64],
    ]);
  });

  it('puts each workload inside its namespace box, and the boxes inside the map', async () => {
    const f = await shop();
    const byId = new Map(f.nodes.map((n) => [n.id, n]));

    expect(
      f.nodes.map((n) => {
        const parent = n.parent === undefined ? { x: 0, y: 0, width: f.width, height: f.height } : byId.get(n.parent);
        return [n.id, parent !== undefined && inside(n, parent as PositionedNode)];
      }),
    ).toStrictEqual(f.nodes.map((n) => [n.id, true]));
  });

  it('lays the calls out from top to bottom: the Internet, then ingress, shop and payments', async () => {
    const f = await shop();

    expect(f.nodes.filter((n) => n.parent === undefined).sort((a, b) => a.y - b.y).map((n) => n.id)).toStrictEqual(['outside', 'namespace:ingress', 'namespace:shop', 'namespace:payments']);
  });

  // A workload's x and y are relative to its namespace box, so both ends of an edge are first placed on the map.
  it("puts every callee below its caller: the callee's top under the caller's bottom", async () => {
    const f = await shop();
    const byId = new Map(f.nodes.map((n) => [n.id, n]));
    const onMap = (id: string) => {
      const n = byId.get(id);
      const parent = n?.parent === undefined ? undefined : byId.get(n.parent);
      return { name: n?.label ?? id, top: (n?.y ?? 0) + (parent?.y ?? 0), height: n?.height ?? 0 };
    };
    /** Below: the callee's top is under the caller's bottom. Above: the other way round. Otherwise the two share a row. */
    const placeOf = (caller: ReturnType<typeof onMap>, callee: ReturnType<typeof onMap>) =>
      callee.top > caller.top + caller.height ? 'below' : callee.top + callee.height < caller.top ? 'above' : 'same row';

    expect(
      f.edges.map((e) => {
        const caller = onMap(e.source), callee = onMap(e.target);
        return [`${caller.name} to ${callee.name}`, placeOf(caller, callee)];
      }),
    ).toStrictEqual([
      ['gateway to frontend', 'below'],
      ['Internet to gateway', 'below'],
      ['api to postgres', 'below'],
      ['cart to api', 'below'],
      ['cart to api', 'below'],
      ['frontend to cart', 'below'],
      ['frontend to cart', 'below'],
      ['recommender to postgres', 'below'],
    ]);
  });
});

it('puts the extra nodes in a column right of the flow, 88 apart, and widens and heightens the flow to fit', () => {
  const cartBox: PositionedNode = { id: 'shop/Deployment/cart', type: 'workload', label: 'cart', sub: '3 pods · in the mesh', tone: 'normal', x: 24, y: 24, width: 176, height: 64 };
  const flow: PositionedFlow = { nodes: [cartBox], edges: [], counts: { workloads: 1, policies: 0, noPolicy: 0 }, width: 400, height: 100 };
  const extras: FlowNode[] = [
    { id: 'outside-mesh', type: 'outside', label: 'Callers outside the mesh', sub: 'no proxy, so no workload name', tone: 'normal' },
    { id: 'unseen:shop/search', type: 'outside', label: 'search', sub: 'shop · not running now', tone: 'normal' },
  ];

  const placed = withExtraNodes(flow, extras);

  expect({ nodes: placed.nodes, width: placed.width, height: placed.height }).toStrictEqual({
    nodes: [
      cartBox,
      { id: 'outside-mesh', type: 'outside', label: 'Callers outside the mesh', sub: 'no proxy, so no workload name', tone: 'normal', x: 448, y: 0, width: 176, height: 64 },
      { id: 'unseen:shop/search', type: 'outside', label: 'search', sub: 'shop · not running now', tone: 'normal', x: 448, y: 88, width: 176, height: 64 },
    ],
    width: 624,
    height: 152,
  });
});

// Each probe renders an open map again; the same flow is laid out once.
it('lays out the same flow once', async () => {
  const [a, b] = [await shop(), await shop()];
  expect(a === b).toBe(true);
});
