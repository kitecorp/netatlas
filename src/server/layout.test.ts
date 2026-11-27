import { describe, expect, it } from 'vitest';
import { SHOP } from '@/model/fixtures/shop';
import { toFlow } from '@/model/flow';
import { clusterGraph, defaultHidden } from '@/model/graph';
import { layoutFlow, type PositionedNode } from './layout';

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

  it('lays the calls out from left to right: the Internet, then ingress, shop and payments', async () => {
    const f = await shop();

    expect(f.nodes.filter((n) => n.parent === undefined).sort((a, b) => a.x - b.x).map((n) => n.id)).toStrictEqual(['outside', 'namespace:ingress', 'namespace:shop', 'namespace:payments']);
  });
});

// Each probe renders an open map again; the same flow is laid out once.
it('lays out the same flow once', async () => {
  const [a, b] = [await shop(), await shop()];
  expect(a === b).toBe(true);
});
