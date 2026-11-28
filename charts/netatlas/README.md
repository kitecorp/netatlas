# netatlas

netatlas shows the NetworkPolicies and Istio AuthorizationPolicies of every Kubernetes cluster you run from one place, and compares them with the traffic Istio records. It edits a NetworkPolicy as a draft in your browser, which ends in Copy YAML for git or in Apply with your own token.

## What it needs and what it may do

- netatlas runs as one pod, installed with its Helm chart in any cluster.
- netatlas reads nine kinds and the ConfigMap istio: namespaces, pods, ReplicaSets, Jobs, DaemonSets, NetworkPolicies, AuthorizationPolicies, ServiceEntries and Sidecars. The ConfigMap is Istio's mesh config, and no other ConfigMap is read. It never reads Secrets.
- For a cluster read with `login.type: inCluster`, the chart's ClusterRole grants get, list and watch on those kinds and nothing else. It cannot read Secrets and cannot change anything.
- Apply writes the draft with your own token, so Kubernetes decides whether you may change the policy. The token is sent in that one request and is not stored, logged or shown again.
- The Traffic and Outbound views need Istio in the cluster, and a Prometheus that scrapes Istio's proxies: the sidecars, and in ambient mode ztunnel. netatlas does not install Prometheus, and reading traffic changes nothing in a cluster.
- netatlas has no login of its own: protect an ingress to it, and serve it over TLS ([The ingress](https://kitecorp.github.io/netatlas/docs/install.html#the-ingress)).

## Install

Install it in a cluster and let it read that cluster with its own ServiceAccount. Write `values.yaml`:

```yaml
clusters:
  - name: my-cluster
    login:
      type: inCluster
```

Then install the chart and open netatlas on http://localhost:3000:

```sh
helm install netatlas oci://ghcr.io/kitecorp/charts/netatlas --version 0.2.1 --namespace netatlas --create-namespace -f values.yaml
kubectl -n netatlas port-forward svc/netatlas 3000:80
```

To read other clusters with a token or with the pod's AWS role on EKS, see [Clusters](https://kitecorp.github.io/netatlas/docs/clusters.html) and [EKS](https://kitecorp.github.io/netatlas/docs/eks.html).

## Traffic and Outbound

To show traffic and what leaves the cluster, name the cluster's Prometheus too. A Prometheus inside the cluster, with no login, needs only its address:

```yaml
clusters:
  - name: my-cluster
    login:
      type: inCluster
    prometheus:
      url: http://prometheus.istio-system:9090
```

A Prometheus with a login, a private CA or the metrics of several clusters: [Traffic and outbound](https://kitecorp.github.io/netatlas/docs/traffic.html#connect-netatlas-to-prometheus).

## Values

| Value | What it is for | Default |
|---|---|---|
| `image` | The image netatlas runs (`repository`, `tag`, `pullPolicy`). | `ghcr.io/kitecorp/netatlas`, with an empty tag, which means the chart's appVersion, and `IfNotPresent` |
| `serviceAccount` | Annotations on the ServiceAccount, such as the AWS role on EKS. | none |
| `podAnnotations` | Annotations on the pod. | none |
| `clusters` | The clusters netatlas reads, and how it logs in to each. The install fails until it lists one. | empty |
| `ingress` | An Ingress for netatlas (`enabled`, `className`, `annotations`, `host`, `tls.secretName`). | off |
| `resources` | The pod's resources. | requests 100m CPU and 256Mi memory, limit 512Mi memory |

Every field is described under [Values](https://kitecorp.github.io/netatlas/docs/install.html#values).

## Documentation and source

- [Documentation](https://kitecorp.github.io/netatlas/): [Install](https://kitecorp.github.io/netatlas/docs/install.html), [Clusters](https://kitecorp.github.io/netatlas/docs/clusters.html), [EKS](https://kitecorp.github.io/netatlas/docs/eks.html), [Editing and Apply](https://kitecorp.github.io/netatlas/docs/editing.html), [Traffic and outbound](https://kitecorp.github.io/netatlas/docs/traffic.html) and [What 0.2.0 leaves out](https://kitecorp.github.io/netatlas/docs/todo.html). 0.2.1 is the same application as 0.2.0; it adds this README and the chart's Artifact Hub details.
- Source: https://github.com/kitecorp/netatlas
- Issues: https://github.com/kitecorp/netatlas/issues

Licence: Apache-2.0 ([LICENSE](https://github.com/kitecorp/netatlas/blob/master/LICENSE)).
