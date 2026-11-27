# Install

netatlas runs as one pod, installed with its Helm chart in any cluster. This page lists what the chart creates, its values, and how to reach netatlas once it runs.

## Chart and image

- Chart: `oci://ghcr.io/kitecorp/charts/netatlas`, version `0.1.0`.
- Image: `ghcr.io/kitecorp/netatlas:0.1.0`, for linux/amd64 and linux/arm64.

```sh
helm install netatlas oci://ghcr.io/kitecorp/charts/netatlas --version 0.1.0 --namespace netatlas --create-namespace -f values.yaml
```

The install fails with `clusters is empty: list at least one cluster for netatlas to read` until `values.yaml` lists at least one cluster. [Clusters](clusters.md) describes each entry.

## What the chart creates

Every object is named after the release, so `helm install netatlas` makes `netatlas` and `netatlas-reader`.

- A ServiceAccount, which netatlas reads the cluster it runs in with and which carries the AWS role on EKS.
- A ClusterRole `netatlas-reader` and its binding to that ServiceAccount, only when a cluster is read with `login.type: inCluster`: get, list and watch on namespaces, pods, ReplicaSets, DaemonSets, Jobs, NetworkPolicies and AuthorizationPolicies, and nothing else. It cannot read Secrets and cannot change anything. Without an `inCluster` cluster the pod gets no ServiceAccount token at all; on EKS, IRSA and Pod Identity mount their own.
- A ConfigMap holding the cluster list netatlas reads at start. A change to the list restarts the pod.
- A Deployment with one replica: each pod keeps its own watch of every cluster, so more would only add load on the API servers. The pod runs as a user that is not root, with a read-only root filesystem and no added capabilities. A cluster read with a token gets its Secret mounted in the pod.
- A Service of type ClusterIP on port 80.
- An Ingress, only when `ingress.enabled` is true.

## Values

| Value | Default | What it does |
|---|---|---|
| `image.repository` | `ghcr.io/kitecorp/netatlas` | The image. |
| `image.tag` | empty | The image tag; empty means the chart's version, `0.1.0`. |
| `image.pullPolicy` | `IfNotPresent` | When the node pulls the image. |
| `serviceAccount.annotations` | none | Annotations on the ServiceAccount, such as `eks.amazonaws.com/role-arn` ([EKS](eks.md)). |
| `podAnnotations` | none | Annotations on the pod. |
| `clusters` | empty | The clusters netatlas reads ([Clusters](clusters.md)). |
| `ingress.enabled` | `false` | Creates the Ingress. |
| `ingress.className` | empty | The Ingress class. |
| `ingress.annotations` | none | Annotations on the Ingress. |
| `ingress.host` | empty | The host the Ingress answers. Required when `ingress.enabled` is true. |
| `ingress.tls.secretName` | empty | The Secret holding the certificate for that host. |
| `resources` | requests 100m CPU and 256Mi memory, limit 512Mi memory | The pod's resources. |

## Reaching netatlas

With port-forward, netatlas answers on http://localhost:3000:

```sh
kubectl -n netatlas port-forward svc/netatlas 3000:80
```

`/api/health` answers 200 with each cluster's state once netatlas has read its cluster list, whether or not the clusters answer, so a cluster that is down never restarts the pod. It answers 503 while netatlas starts. The pod's readiness and liveness probes read it.

## The ingress

netatlas has no login of its own. Anyone who can reach the ingress's host sees every cluster's policies, so protect the ingress, for example with your identity proxy or a network that only your team reaches.

Apply sends a Kubernetes token from the browser to netatlas, so serve the ingress over TLS: set `ingress.tls.secretName`, or end TLS at a load balancer in front of it. The editor offers Apply only on a page the browser counts as secure, which is HTTPS or `localhost` and `127.0.0.1` through port-forward; on a plain HTTP address it says why and Copy YAML still works. Without a TLS secret the install notes say so.
