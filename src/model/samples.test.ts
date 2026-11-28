import { expect, it } from 'vitest';
import { workloadIndex } from './destinations';
import { SHOP } from './fixtures/shop';
import { AMBIENT, bytes, call, SHOP_ROWS } from './fixtures/traffic';
import type { PromSample } from './prometheus-answer';
import { countOnce, fromSource, labelOf } from './samples';
import type { ClusterResources } from './types';

// a: the caller's report; b: the callee's report of the same call; h: a callee's report of a caller with no
// proxy; k: a waypoint's copy of a.
const { a, b, h, k } = SHOP_ROWS;

// ztunnel names a caller that has no proxy by its address (inbound_passthrough.rs:166-200), so the callee's
// report is the only one, with a known source_workload: the gateway is seen, and outside the mesh.
const fromGateway = bytes(call('destination', 'ingress/gateway', 'shop/frontend'), 2000);

it.each<[string, PromSample[], ClusterResources, PromSample[]]>([
  ['the shop\'s rows: the callee\'s report only where Istio could not name the caller', [a, b, h, k], SHOP, [a, h]],
  ['the callee\'s report of a seen caller outside the mesh', [fromGateway], AMBIENT.resources, [fromGateway]],
  // Only a proxy names its caller to the callee, so a named caller netatlas does not see had one: its own report counts the call.
  ['the callee\'s report of a named caller netatlas does not see', [bytes(call('destination', 'shop/search', 'shop/frontend'), 100)], SHOP, []],
])('countOnce keeps the callers\' reports, and the callees\' reports of callers with no proxy %#: %s', (_name, samples, resources, expected) => {
  expect(countOnce(samples, workloadIndex(resources))).toStrictEqual(expected);
});

it('fromSource keeps the callers\' reports only', () => {
  expect(fromSource([a, b, h, k])).toStrictEqual([a]);
});

it.each<[string, PromSample, string, string]>([
  ['a label Telemetry removed', { labels: {}, value: 1 }, 'destination_service', 'unknown'],
  ['an empty label', { labels: { destination_service: '' }, value: 1 }, 'destination_service', 'unknown'],
  ['a label with a value', a, 'destination_service', 'cart.shop.svc.cluster.local'],
])('labelOf %#: %s', (_name, sample, label, expected) => {
  expect(labelOf(sample, label)).toBe(expected);
});
