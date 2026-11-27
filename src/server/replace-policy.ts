import { CustomObjectsApi, type KubeConfig } from '@kubernetes/client-node';
import type { NetworkPolicyObject } from '@/model/types';

/**
 * Replaces one NetworkPolicy, sending and receiving it as plain JSON. The typed NetworkingV1Api
 * serializes through its V1NetworkPolicy model, which drops every field the model does not know, so a
 * field a newer Kubernetes adds would be lost on Apply. The read lists the same kind as plain JSON too.
 * A refusal throws an ApiException carrying the status, as the typed client does.
 */
export async function replacePolicy(kc: KubeConfig, body: NetworkPolicyObject): Promise<NetworkPolicyObject> {
  const { name, namespace } = body.metadata;
  const api = kc.makeApiClient(CustomObjectsApi);
  return (await api.replaceNamespacedCustomObject({ group: 'networking.k8s.io', version: 'v1', plural: 'networkpolicies', namespace, name, body })) as NetworkPolicyObject;
}
