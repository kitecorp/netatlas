import { expect, it } from 'vitest';
import { isEgressGateway, isGatewayOrWaypoint, isIngressGateway, isWaypoint } from './istio-proxies';
import type { Labels, ProxyRole } from './types';

it.each<[string, { labels: Labels; proxyRole?: ProxyRole }, boolean]>([
  ['an ingress gateway', { labels: { app: 'istio-ingressgateway', istio: 'ingressgateway' } }, true],
  ['an egress gateway', { labels: { app: 'istio-egressgateway', istio: 'egressgateway' } }, true],
  ['a waypoint', { labels: { 'gateway.networking.k8s.io/gateway-name': 'waypoint', 'gateway.networking.k8s.io/gateway-class-name': 'istio-waypoint' } }, true],
  ['a Gateway API gateway', { labels: { 'gateway.networking.k8s.io/gateway-name': 'public', 'gateway.networking.k8s.io/gateway-class-name': 'istio' } }, true],
  // istiod carries istio=pilot: the key istio alone does not make a gateway.
  ['istiod', { labels: { app: 'istiod', istio: 'pilot' } }, false],
  ['a workload', { labels: { app: 'cart' } }, false],
  ['no labels', { labels: {} }, false],
  // The gateway chart labels a pod istio=<release name without istio->, here istio=ingress; its proxy runs as router.
  ['the gateway chart, by its role', { labels: { app: 'istio-ingress', istio: 'ingress' }, proxyRole: 'router' }, true],
  ['a waypoint, by its role alone', { labels: { app: 'mesh-waypoint' }, proxyRole: 'waypoint' }, true],
  ['a sidecar', { labels: { app: 'cart' }, proxyRole: 'sidecar' }, false],
  // A gateway-name label copied onto an application's pod: its proxy runs as a sidecar, which no gateway does.
  ['a sidecar with a gateway name', { labels: { app: 'cart', 'gateway.networking.k8s.io/gateway-name': 'public' }, proxyRole: 'sidecar' }, false],
])('isGatewayOrWaypoint: %s', (_name, pod, expected) => {
  expect(isGatewayOrWaypoint(pod)).toBe(expected);
});

type Kind = { waypoint: boolean; ingress: boolean; egress: boolean };
const NEITHER: Kind = { waypoint: false, ingress: false, egress: false };

it.each<[string, { labels: Labels; proxyRole?: ProxyRole }, Kind]>([
  ['an ingress gateway', { labels: { app: 'istio-ingressgateway', istio: 'ingressgateway' } }, { waypoint: false, ingress: true, egress: false }],
  ['an ingress gateway, its proxy a router', { labels: { app: 'istio-ingressgateway', istio: 'ingressgateway' }, proxyRole: 'router' }, { waypoint: false, ingress: true, egress: false }],
  ['an egress gateway', { labels: { app: 'istio-egressgateway', istio: 'egressgateway' } }, { waypoint: false, ingress: false, egress: true }],
  ['an egress gateway, its proxy a router', { labels: { app: 'istio-egressgateway', istio: 'egressgateway' }, proxyRole: 'router' }, { waypoint: false, ingress: false, egress: true }],
  // A waypoint carries the gateway-name label too, and is no ingress gateway.
  ['a waypoint, by its labels', { labels: { 'gateway.networking.k8s.io/gateway-name': 'waypoint', 'gateway.networking.k8s.io/gateway-class-name': 'istio-waypoint' } }, { waypoint: true, ingress: false, egress: false }],
  ['a waypoint, by its role alone', { labels: { app: 'mesh-waypoint' }, proxyRole: 'waypoint' }, { waypoint: true, ingress: false, egress: false }],
  // The gateway-name label without the waypoint class reads as a Gateway API gateway; the role says waypoint, which wins.
  ['a waypoint role with a gateway name', { labels: { 'gateway.networking.k8s.io/gateway-name': 'waypoint' }, proxyRole: 'waypoint' }, { waypoint: true, ingress: false, egress: false }],
  // Any value of the key: the class here is istio, not istio-waypoint.
  ['a Gateway API gateway', { labels: { 'gateway.networking.k8s.io/gateway-name': 'public', 'gateway.networking.k8s.io/gateway-class-name': 'istio' } }, { waypoint: false, ingress: true, egress: false }],
  // A router may be an ingress or an egress gateway, and its role cannot tell which: under other labels it is neither.
  ['the gateway chart, by its role', { labels: { app: 'istio-ingress', istio: 'ingress' }, proxyRole: 'router' }, NEITHER],
  // istiod carries istio=pilot: the key istio alone makes no gateway.
  ['istiod', { labels: { app: 'istiod', istio: 'pilot' } }, NEITHER],
  ['a sidecar', { labels: { app: 'cart' }, proxyRole: 'sidecar' }, NEITHER],
  ['a sidecar with a gateway name', { labels: { app: 'cart', 'gateway.networking.k8s.io/gateway-name': 'public' }, proxyRole: 'sidecar' }, NEITHER],
  ['no labels', { labels: {} }, NEITHER],
])('isWaypoint, isIngressGateway, isEgressGateway: %s', (_name, pod, expected) => {
  expect({ waypoint: isWaypoint(pod), ingress: isIngressGateway(pod), egress: isEgressGateway(pod) }).toStrictEqual(expected);
});
