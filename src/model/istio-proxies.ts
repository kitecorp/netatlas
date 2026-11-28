import type { PodInfo } from './types';

/** What these functions read of a pod: its labels and its proxy's role, as a PodInfo or a PodClass carries them. */
export type ProxySigns = Pick<PodInfo, 'labels' | 'proxyRole'>;

/**
 * Istio puts the gateway name on the pods of every Gateway API gateway it deploys, waypoints included,
 * and the class `istio-waypoint` on a waypoint's (waypoint.yaml:59-70).
 */
const GATEWAY_NAME = 'gateway.networking.k8s.io/gateway-name';
const GATEWAY_CLASS = 'gateway.networking.k8s.io/gateway-class-name';

/**
 * Whether a pod is one of Istio's gateways or a waypoint: such a proxy forwards what its routes name,
 * and neither a Sidecar nor the mesh's outbound mode governs it. Its proxy's role is the sure sign,
 * because every gateway runs as `router` whatever its labels (the gateway Helm chart labels its pods
 * `istio: <release name>`); the labels are a second sign, read only when the role is not known.
 */
export function isGatewayOrWaypoint(pod: ProxySigns): boolean {
  return pod.proxyRole === 'router' || isWaypoint(pod) || isIngressGateway(pod) || isEgressGateway(pod);
}

/**
 * A proxy known to run as a sidecar is an application's, whatever labels its pod carries: no gateway or
 * waypoint runs as `sidecar`, and a label is easily copied onto another pod.
 */
const isKnownSidecar = ({ proxyRole }: ProxySigns): boolean => proxyRole === 'sidecar';

/** A waypoint: its proxy runs as `waypoint`, or its pod carries the istio-waypoint gateway class. */
export function isWaypoint(pod: ProxySigns): boolean {
  return pod.proxyRole === 'waypoint' || (!isKnownSidecar(pod) && pod.labels[GATEWAY_CLASS] === 'istio-waypoint');
}

/**
 * An ingress gateway: not a waypoint, and labelled `istio=ingressgateway` or with a Gateway API gateway
 * name. A `router` may be an ingress or an egress gateway, so its role does not tell which.
 */
export function isIngressGateway(pod: ProxySigns): boolean {
  return !isKnownSidecar(pod) && !isWaypoint(pod) && (pod.labels.istio === 'ingressgateway' || Object.hasOwn(pod.labels, GATEWAY_NAME));
}

/** A pod of istiod: the istiod chart labels each one `app: istiod`, revisioned installs included (istio-discovery templates/deployment.yaml:46). */
export const isIstiod = ({ labels }: Pick<ProxySigns, 'labels'>): boolean => labels.app === 'istiod';

/** An egress gateway: labelled `istio=egressgateway`. */
export function isEgressGateway(pod: ProxySigns): boolean {
  return !isKnownSidecar(pod) && pod.labels.istio === 'egressgateway';
}
