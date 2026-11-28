# Clusters

The chart's `clusters` value lists every cluster netatlas reads and how it logs in to each. netatlas checks the list when it starts and refuses one that breaks a rule below, naming the cluster and the rule.

## Fields

Each entry of `clusters` has these fields:

- `name`: how netatlas shows the cluster, and the cluster's part of each address in the app. It is 1 to 63 lowercase letters, digits or dashes, and each name appears once.
- `server`: the cluster's API server, starting with `https://`. Every cluster but an `inCluster` one needs it.
- `caData`: the API server's CA, as base64 PEM. A `token` cluster may leave it out and use the `ca.crt` of its Secret instead; an `eks` cluster needs it.
- `login.type`: how netatlas logs in:
  - `inCluster`: the cluster netatlas runs in, read with its own ServiceAccount. At most one cluster uses it, and it takes no `server` and no CA.
  - `token`: a ServiceAccount token kept in a Secret beside netatlas. `login.secretName` names the Secret, which holds `token` and `ca.crt`.
  - `eks`: the pod's AWS role signs the token `aws eks get-token` makes. `login.clusterName` is the EKS cluster's name and `login.region` its AWS region ([EKS](eks.md)).
- `istio.rootNamespace` and `istio.trustDomain`: only when the cluster's Istio uses other values than `istio-system` and `cluster.local`. netatlas reads Istio's mesh config from the ConfigMap `istio` in the namespace istiod runs in, which it takes to be the root namespace. It must be a namespace name, a DNS label: netatlas refuses another value at start with `registry: cluster "<name>" istio rootNamespace "<value>" is not a namespace name`.
- `clusterDomain`: the DNS domain the cluster's service hosts end in, only when it is not `cluster.local`. netatlas uses it to tell calls to the cluster's own services (`<service>.<namespace>.svc.<domain>`) from calls that leave the cluster. It must be a DNS name.
- `prometheus`: the Prometheus that holds the cluster's Istio metrics, which the Traffic and Outbound views need. A cluster without it shows no traffic. Its fields (`url`, `auth`, `caData` and `clusterLabel`) are in [Traffic and outbound](traffic.md#connect-netatlas-to-prometheus).

## One entry for each login

```yaml
clusters:
  - name: here
    login:
      type: inCluster
  - name: lab
    server: https://203.0.113.10:6443
    login:
      type: token
      secretName: netatlas-lab
  - name: prod-eu-1
    server: https://ABCDEF0123456789.gr7.eu-west-1.eks.amazonaws.com
    caData: LS0tLS1CRUdJTi...
    login:
      type: eks
      clusterName: prod-eu-1
      region: eu-west-1
    istio:
      trustDomain: prod.example
```

## A cluster read with a token

netatlas reads a `token` cluster with a ServiceAccount that only reads. [deploy/reader-access.yaml](../deploy/reader-access.yaml) creates it in the namespace `netatlas-access`, with the same read-only ClusterRole the chart gives netatlas, and a Secret `netatlas-reader-token` that Kubernetes fills with a token that does not expire and the cluster's CA.

1. Apply it in the cluster to read, and wait until Kubernetes has filled in the token:

   ```sh
   kubectl --context <cluster-to-read> apply -f deploy/reader-access.yaml
   until [ -n "$(kubectl --context <cluster-to-read> -n netatlas-access get secret netatlas-reader-token -o go-template='{{if .data}}{{if .data.token}}filled{{end}}{{end}}')" ]; do
     sleep 1
   done
   ```

2. Copy the token and the CA into a Secret beside netatlas, in the cluster where netatlas runs. The values go from one cluster to the other through a pipe, still in base64, and are never printed:

   ```sh
   kubectl --context <netatlas-cluster> create namespace netatlas --dry-run=client -o yaml | kubectl --context <netatlas-cluster> apply -f -
   kubectl --context <cluster-to-read> -n netatlas-access get secret netatlas-reader-token -o go-template='apiVersion: v1
   kind: Secret
   type: Opaque
   metadata:
     name: netatlas-<name>
     namespace: netatlas
   data:
     token: {{index .data "token"}}
     ca.crt: {{index .data "ca.crt"}}
   ' | kubectl --context <netatlas-cluster> apply -f -
   ```

3. Name that Secret in the cluster's entry, as `login.secretName: netatlas-<name>`, with the cluster's `server`, and install or upgrade the chart.

The token must be made of visible ASCII characters only: no space, no control character and no other character inside it. netatlas does not send a token that holds one, and raises the error `the token file holds a character an Authorization header cannot carry`, which names neither the token nor the file. The cluster's page then gives the reason `netatlas's token file holds a character an Authorization header cannot carry`, and the log says `netatlas: cluster <name>: the token file holds a character an Authorization header cannot carry`, once, until a check of the cluster passes. A token file that goes bad while netatlas is reading the cluster gives two log lines for the one cause ([What 0.2.0 leaves out](todo.md)).

## A cluster netatlas cannot reach

Each cluster is read on its own, so one that stops answering stops nothing else. netatlas checks every cluster every 15 seconds. When a check fails, the overview's row for that cluster says `Unreachable since` the time it stopped answering and why, for example that the API server stopped answering, then `Showing data from` how long ago, with the workloads and policies it read last. The cluster's map, policy, traffic and Outbound pages, and its part of the policy list, show the same line above the last data. Every page counts that age from the same moment: the last time netatlas held the cluster's state. A cluster that answers while netatlas is reading it again, after an outage or after a list failed, shows `reading` with the age of its data instead of a fresh time. Apply is not offered for it, and Copy YAML still works. netatlas tries again after 5 seconds, then waits twice as long each time, up to 5 minutes, and the pages change by themselves once it answers.

## A kind netatlas may not read

When a cluster's API server refuses to let netatlas list a kind, netatlas says so instead of reading it as empty. The overview shows `cannot read` in the counts that need it, and a policy count says what it read and which kind it could not, for example `2 · cannot read AuthorizationPolicies`; the cards above it name the clusters they leave out. The map, the traffic view, the Outbound view, the policy list and a policy's page say, for example, `Cannot read NetworkPolicies: netatlas's role does not allow it.` The map, the traffic view and the Outbound view name the kinds their verdicts rest on: Namespaces, Pods, ReplicaSets, Jobs, NetworkPolicies, AuthorizationPolicies, ServiceEntries and Sidecars. A workload is never called open, and never said to have no policy, while netatlas cannot read the policies that might select it. The traffic view and the Outbound view state no verdict about what the policies allow, refuse or select that rests on NetworkPolicies, AuthorizationPolicies, Sidecars or ServiceEntries that netatlas may not read: they say `depends: netatlas's role may not read <kind>` instead ([What "depends" means](traffic.md#what-depends-means)). The traffic map then draws no dotted line for a pair the policies allow and nobody called, because the kind it may not read could refuse any pair, and the Outbound view says `No destination outside the cluster.` only when it could read every kind it rests on.

The promise covers those four kinds and no others. Without Pods, the traffic view reads every workload its metrics name as `not running now`. Without ReplicaSets or Jobs, netatlas names a pod by its ReplicaSet or Job, not by the Deployment or CronJob that made it, so the Policy map draws the workload under that name. Istio names a Deployment's pod by the Deployment, so without ReplicaSets the traffic view reads the calls of a Deployment's pods as to or from a workload not running now, and the line `Cannot read ReplicaSets: netatlas's role does not allow it.`, which the Policy map prints too, is what says why; what a person sees without Jobs for a CronJob's pods was not traced. A DaemonSet netatlas may not read gets no such line on these three views, and what it changes there was not traced ([What 0.2.0 leaves out](todo.md)).
