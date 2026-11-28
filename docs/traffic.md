# Traffic and outbound

netatlas draws the calls between your workloads, and the calls that leave your cluster, from the metrics Istio's proxies write to Prometheus. It compares each call with the policies it read, so you see what runs without a policy, what a policy allows that nobody uses, and what is being refused. This page connects netatlas to Prometheus, says how to read the map, what each figure and mark means and what the Outbound view lists, and lists what Istio's metrics cannot tell netatlas.

## What you need

- Istio in the cluster, and a Prometheus that scrapes Istio's proxies: the sidecars, and in ambient mode ztunnel. netatlas leaves out what waypoints report, so it needs nothing from them. netatlas does not install Prometheus, and reading traffic changes nothing in a cluster. Istio's own documentation describes a sample Prometheus for this and calls it "intended for demonstration only, and is not tuned for performance or security".
- A `prometheus` entry in each cluster whose traffic you want to see. A cluster without one says `No traffic source for <cluster>: its registry entry names no Prometheus.` wherever traffic would show. Its policies and workloads are not affected.
- A read role that includes ServiceEntries, Sidecars and Istio's mesh config ([The role](#the-role)).

## Connect netatlas to Prometheus

Add `prometheus` to the cluster's entry in the chart's `clusters` value. Its fields:

| Field | What it does |
|---|---|
| `url` | Where Prometheus answers, starting `http://` or `https://`. Required. Do not put a user or password in it: netatlas refuses such a URL, and `auth.type: basic` is how to send them. A path stays: `https://example.com/prometheus` is asked at `/prometheus/api/v1/query`. |
| `auth.type` | `none` (the default) sends no credentials. `bearer` sends `Authorization: Bearer <token>`: Prometheus itself checks only basic authentication, so use `bearer` for a proxy or a hosted service in front of it. `basic` sends a user name and a password. |
| `auth.secretName` | Required for `bearer` and `basic`. A Secret in the namespace netatlas is installed in, with the keys below. |
| `caData` | The CA of an `https://` Prometheus, as base64 PEM. Leave it out when a public CA signed its certificate. |
| `clusterLabel` | `name` and `value`, for one Prometheus that holds the metrics of several clusters. netatlas adds `name="value"` to every query, so the cluster counts only the series that carry that label value. The label must be on the Istio series. |

The Secret holds one key for each credential:

| `auth.type` | Secret keys |
|---|---|
| `bearer` | `token` |
| `basic` | `username` and `password` |

Create the Secret in the namespace netatlas is installed in, before you install or upgrade the chart. This one holds a basic login:

```sh
kubectl --namespace netatlas create secret generic netatlas-prometheus-prod-eu-1 --from-file=username=./username.txt --from-file=password=./password.txt
```

Then name it in the cluster's entry. This entry reads a Prometheus behind HTTPS with a private CA, and it shares that Prometheus with other clusters:

```yaml
clusters:
  - name: prod-eu-1
    server: https://ABCDEF0123456789.gr7.eu-west-1.eks.amazonaws.com
    caData: LS0tLS1CRUdJTi...
    login:
      type: eks
      clusterName: prod-eu-1
      region: eu-west-1
    prometheus:
      url: https://prometheus.example.com
      auth:
        type: basic
        secretName: netatlas-prometheus-prod-eu-1
      caData: LS0tLS1CRUdJTi...
      clusterLabel:
        name: cluster
        value: prod-eu-1
```

A Prometheus inside the cluster, with no login, needs only its address:

```yaml
clusters:
  - name: my-cluster
    login:
      type: inCluster
    prometheus:
      url: http://prometheus.istio-system:9090
```

### How netatlas handles the credentials

- Credentials come only from files the chart mounts from your Secret. netatlas never reads a Secret through the Kubernetes API.
- netatlas trims each value, so a file saved with a trailing newline works. It reads the files again once the last read is a minute old, so a rotated Secret works without a restart, as soon as Kubernetes has updated the mounted files.
- A `bearer` token must be made of visible ASCII characters only: no space, no control character and no other character inside it. netatlas does not send a token that holds one, and the reason reads `the Prometheus credentials could not be read`. A `basic` login has no such limit.
- With `http://` and a `bearer` or `basic` login, the credential crosses the network unencrypted. netatlas does not refuse `http://`, because a Prometheus inside the cluster often has no TLS. Use `https://` when the credential would travel over a network you do not trust.
- netatlas never stores, logs or shows a token, a password or an Authorization header. A reason or an error names what failed: an HTTP status, a socket error, the size of an answer, which mounted file could not be read, or Prometheus's own error text. It never quotes a header. Prometheus's text is shown with each control character made a space and is cut at 200 characters, ending in `…`, because it goes into the log and onto every page.

### What the chart and netatlas refuse

The chart stops `helm install` with one of these:

- `cluster "<name>" sets prometheus, so it needs prometheus.url`
- `cluster "<name>" prometheus.url must not carry a user or password: use prometheus.auth basic with a Secret`
- `cluster "<name>" prometheus.auth.type "<type>" is not none, bearer or basic`
- `cluster "<name>" uses prometheus <type> auth, so it needs prometheus.auth.secretName`
- `cluster "<name>" is too long to name its Secret volume: at most 52 characters with a Prometheus Secret, 55 with a token Secret`

netatlas stops at start, naming the cluster, when:

- the URL does not start with `http://` or `https://`, or is not a URL it can read;
- the URL carries a user or a password (`use auth basic with a Secret`);
- `clusterLabel` lacks a `name` or a `value`, or its name is not a Prometheus label name;
- `clusterDomain` is not a DNS name.

## What netatlas asks Prometheus

netatlas sends five fixed queries to `<url>/api/v1/query`. Nothing a browser sends reaches a query. They count Istio's standard metrics:

```text
requests:
sum by (reporter, source_workload, source_workload_namespace, source_cluster, destination_workload, destination_workload_namespace, destination_service, destination_service_name, destination_cluster, response_code, response_flags) (rate(istio_requests_total{reporter=~"source|destination"}[5m])) > 0

requestBytes:
sum by (reporter, source_workload, source_workload_namespace, source_cluster, destination_workload, destination_workload_namespace, destination_service, destination_service_name, destination_cluster) (rate(istio_tcp_received_bytes_total{reporter=~"source|destination"}[5m])) > 0

responseBytes:
sum by (reporter, source_workload, source_workload_namespace, source_cluster, destination_workload, destination_workload_namespace, destination_service, destination_service_name, destination_cluster) (rate(istio_tcp_sent_bytes_total{reporter=~"source|destination"}[5m])) > 0

closed:
sum by (reporter, source_workload, source_workload_namespace, source_cluster, destination_workload, destination_workload_namespace, destination_service, destination_service_name, destination_cluster, response_flags) (rate(istio_tcp_connections_closed_total{reporter=~"source|destination"}[5m])) > 0

recent:
sum by (reporter, source_workload, source_workload_namespace, destination_workload, destination_workload_namespace) (increase(istio_requests_total{reporter=~"source|destination"}[24h])) > 0 or sum by (reporter, source_workload, source_workload_namespace, destination_workload, destination_workload_namespace) (increase(istio_tcp_connections_opened_total{reporter=~"source|destination"}[24h])) > 0
```

- The first four give the figures of the Traffic view. The fifth, `recent`, lists the pairs of workloads that had any call in the last 24 hours.
- Each of the first four ends in `> 0`. A series whose 5-minute rate is 0 was seen earlier and is idle now, so it is not a call, and the query leaves it out. Only the `recent` pairs tell that a pair of workloads was seen lately.
- The matcher keeps the reports of the caller's proxy (`reporter="source"`) and of the callee's (`reporter="destination"`), and leaves out a waypoint's. A call is reported on both ends, so netatlas counts each call once: the caller's report, plus the callee's only where the caller has no proxy to report it. A caller has no proxy when `source_workload` is `unknown`, or when it names a pod netatlas sees that is not in the mesh (ztunnel names such a caller; a sidecar cannot). The callee's report is also kept when its `source_cluster` and `destination_cluster` are both known and differ: a caller in another cluster of the mesh reports into that cluster's own Prometheus, so this cluster's figures do not hold its report.
- netatlas reads labels by name. A label that is missing, for example one an operator removed with Istio's Telemetry API, reads as `unknown`. What that does depends on the label. With `source_workload` unknown, the caller counts as one netatlas cannot name. With the destination's workload, `destination_service` and `destination_service_name` all unknown, the call is unattributed traffic. A call to a ServiceEntry host that loses only `destination_service` reads as a call to a workload `not running now`, because its workload name is the entry's own making ([What workloads do call](#what-workloads-do-call)).
- netatlas ignores the `namespace` and `pod` labels of the scrape: in Istio's sample Prometheus they hold the namespace and name of the pod that was scraped, which is the proxy that reported, not the workload.
- With a `clusterLabel`, each query's selector also carries it, for example `istio_requests_total{reporter=~"source|destination", cluster="prod-eu-1"}`.

### How often

- The four figure queries run every 30 seconds, together. The next poll starts 30 seconds after the last one ended, so a slow Prometheus never gets two polls at once.
- The `recent` query runs every 10 minutes. After a failure it runs again 2 minutes later, and every 2 minutes until one succeeds, so a heavy query that keeps timing out is not sent every 30 seconds. The pairs already shown stay meanwhile. When the last answer of `recent` is more than 30 minutes older than the figures, which means the query keeps failing while the figures go on, netatlas treats it as not answered: idle edges read `no traffic, 5 min`, and nothing is listed under Allowed, not used.
- A query that gets no answer in 10 seconds fails with `Prometheus stopped answering`.

### When Prometheus does not answer

The cluster stays reachable, and netatlas keeps asking. The pages that show traffic say `Traffic unavailable since <time>: <reason>.` and go on showing the last figures: `Showing figures from <age>.`, or `No figures yet.` when there are none. While netatlas has not read Prometheus once, they say `Reading traffic from Prometheus.` The views column counts the sources under Data sources, for example `Prometheus, 1 of 2`: how many of the clusters that name a Prometheus answer now. Every open page changes that count when a source starts or stops answering, not only the pages that show traffic. The reason is one of these:

| Reason | What it means |
|---|---|
| `Prometheus refused the connection` | Nothing listens at the `url`. |
| `Prometheus stopped answering` | No answer in 10 seconds, or the host cannot be reached. |
| `the address of Prometheus could not be resolved` | The host name does not resolve. |
| `Prometheus's certificate was not accepted` | The certificate is self-signed, expired, signed by a CA netatlas does not trust, or does not name the host. For a private CA, set `caData`. |
| `Prometheus did not accept netatlas's credentials` | HTTP 401: check the Secret. |
| `netatlas's credentials may not query Prometheus` | HTTP 403: the login may not run queries. |
| `Prometheus answered HTTP <status> with a body that is not JSON` | Usually a proxy in front of Prometheus answering with a login page or a redirect. netatlas never reads such an answer as "no traffic". |
| `Prometheus refused the query: <type>: <message>` | Prometheus rejected one of the five queries. The text is Prometheus's own, with control characters made spaces and cut at 200 characters. |
| `Prometheus answered with a body larger than 16 MiB` | netatlas does not read an answer larger than 16 MiB, because the pod's memory is limited, and the query fails. |
| `Prometheus answered with a body netatlas does not understand` | The answer is JSON that is not a Prometheus query result. |
| `the Prometheus credentials could not be read` | The Secret is not mounted, or lacks a key, or the `bearer` token holds a character an Authorization header cannot carry. |
| `Prometheus could not be reached` | Any other failure. |

The log names the cause too, without a token or a header. When a source stops, netatlas logs `netatlas: cluster <name>: <source> stopped: <message>`, where `<source>` is `Kubernetes API` or `Prometheus`. When a check finds a token file no header can carry, it logs `netatlas: cluster <name>: the token file holds a character an Authorization header cannot carry`, once until a check passes. When one of the pages listening for a change fails while netatlas tells them, it logs `netatlas: a listener of <cluster> failed: <message>`, and the other pages still hear the change.

## What the figures mean

- Every figure is a rate per second, averaged over the last 5 minutes and read again every 30 seconds. A change shows up gradually: a service that stopped a minute ago is still in the average.
- An edge's label shows up to three figures, joined with ` · `: requests per second, the share of them answered with a 5xx code, and bytes per second with both directions added, for example `52 req/s · 2.1% errors · 18 kB/s`. A figure that is 0 is left out. A request edge shows requests and errors; a TCP edge shows bytes. TCP connections closed per second are in the label only when they are the only figure, as on a connection refused before it carried a byte: `0.2 conn/s`, or `< 0.1 conn/s` below the smallest step. In words they read `0.2 connections a second` or `1 connection a second`. Otherwise they decide the refused marks, and they count toward a destination's rate on the Outbound view.
- A figure below its smallest step reads `< 0.1 req/s`, `< 0.1 conn/s`, `< 0.1%` or `< 1 B/s`.
- "No calls recorded in the last 24 hours" is only as good as Prometheus's retention. A Prometheus that keeps less than a day has recorded less, so netatlas says "recorded", not "made". It says so only while the pairs of the 24-hour query are at most 30 minutes older than the figures ([How often](#how-often)).
- The marks compare workloads, not ports: Istio's metrics carry no destination port.

## The map

The Policy map and the Traffic view draw a cluster the same way:

- The map is laid out top to bottom: a caller sits above what it calls.
- It is scaled to fit the width of its box when it is first drawn, and never above its full size. The box is as tall as the scaled map, so the whole cluster is drawn, and a tall one makes the page longer: scroll the page to see the rest. The box itself does not scroll.
- The buttons Zoom In, Zoom Out and Fit View are at the bottom of the map. Drag the map to move it. A pinch, or Ctrl and scroll, zooms it, and plain scrolling still scrolls the page.
- Until you zoom or drag, the map stays fitted when its box changes size, for example when a side panel opens or you resize the window. Fit View fits it again.
- A screen reader finds the map named `Policy map of <cluster>` or `Traffic map of <cluster>`. The spoken label of an edge names a workload by its name, or as `<namespace> / <name>` when another workload of the cluster has the same name, as What stands out does.
- You move the map by dragging it. Moving it with the keyboard, and a layout for a phone, are not done yet ([What 0.2.0 leaves out](todo.md)).

The Policy map and the workload panel draw each layer's own lines: a NetworkPolicy's and an Istio policy's, never merged. A call passes only when both layers let it through, so an Istio line can be drawn for a pair a NetworkPolicy refuses, and a NetworkPolicy line for a pair Istio refuses. The legend line `an Istio AuthorizationPolicy allows it` has the same limit. The Traffic view's Allowed, not used lists a pair only when neither layer refuses it.

## The Traffic view

The Traffic view draws one cluster on the policy map's layout, so each workload sits where it does on the Policy map. Choose Traffic in the views column, under Network. With All clusters chosen it says `Choose a cluster to see its traffic.` and lists the clusters.

Above the map are what it measures (`Requests measured by Istio, read from Prometheus`), the namespaces it shows (`Namespaces: 3 of 5`, a list of checkboxes), the window (`Last 5 minutes`, fixed) and the Compare with policies button, which is on until you turn it off. [The map](#the-map) says how to move around it. When no namespace box is drawn, the map says `No namespace is shown. Open Namespaces to show one.` above what is still drawn. That includes a pick of only namespaces that hold no workload, because a namespace with no workload is never drawn as a box.

Each workload's box says how many pods it has and where it stands: `2 pods · in the mesh`, `1 pod · not in the mesh`, `2 pods · no policy` for a workload in the mesh that no policy selects (the box then leaves out `in the mesh`), or `1 pod · not in the mesh · no policy`. A workload that only DENY or CUSTOM AuthorizationPolicies select counts as having a policy, so it never reads `no policy`, though Istio lets in every request those policies do not refuse ([What 0.2.0 leaves out](todo.md)). Each edge is a caller and what it called in the last 5 minutes, labelled with its figures (for example `52 req/s · 2.1% errors`). Besides the workloads, the map draws these nodes:

| Node | When it is drawn |
|---|---|
| `Internet` (`outside the cluster`) | Always, for a cluster with a traffic source. Every call that leaves the cluster is an edge to it, and every call from a caller in another cluster of the mesh is an edge from it. |
| `Callers outside the mesh` (`no proxy, so no workload name`) | A call whose caller has no proxy and no name. |
| A workload's name (`<namespace> · not running now`) | The metrics name a workload that netatlas does not see in the cluster. |
| A service's name (`no workload answered`) | A service of the cluster that no workload answered. |

With Compare with policies on, every edge carries a mark.

### The marks

netatlas gives a traffic edge the first of the first seven marks below that holds, in this order, with the exceptions the rows name, and draws it as the legend under the map says. The last line is for an edge with no traffic. The first column has the legend's lines, in the legend's words:

| Legend line | It holds when | What to do |
|---|---|---|
| `leaves the cluster` | The destination is not a workload of the cluster: a host, an address Istio did not name, a call REGISTRY_ONLY blocked, or a call into another cluster of the mesh. | The edge goes to the Internet node. The [Outbound view](#the-outbound-view) lists each destination. |
| `not compared with the policies, or not measured` | The caller is outside the mesh, in another cluster of the mesh, or not running now, or the destination is not running now, is a service no workload answered, or is a waypoint. netatlas cannot match these to policies. The edge from the Internet node to an ingress gateway ([below](#the-internet-node-and-the-notes-on-edges)) is in this line too, and so is an idle edge that is `not measured` ([Allowed, but no traffic](#allowed-but-no-traffic)). So is a measured pair that would have read allowed, covered by no policy or answered though the policies deny it, while netatlas may not read the NetworkPolicies or the AuthorizationPolicies: the edge says `depends: netatlas's role may not read ...` and the page names the kind ([A kind netatlas may not read](clusters.md#a-kind-netatlas-may-not-read)). | Nothing: the edge is drawn without a verdict. For a kind netatlas may not read, apply the rules of [The role](#the-role). |
| `refused by Istio` | For requests: every answer was a 403, and Istio's own rule denies the call (below). For TCP in ambient mode: the callee's ztunnel closed every connection it reported with `DENY`, whether or not the pair also has requests. For TCP between sidecars: there are no requests, every connection closed with no byte sent back, and Istio's own rule denies the call. | Check the AuthorizationPolicies of the callee. |
| `refused by the network` | For requests: every one was a 503 with the response flag `UF`, `UH` or `URX` (the upstream connection failed, no upstream was healthy, or the retries ran out). For TCP: every closed connection carried `UF` (Envoy's connection failure) or one of ztunnel's flags for a connection that failed: `CONNECT`, `NETWORK_POLICY`, `TLS_FAILURE`, `H2_HANDSHAKE_FAILURE`, `IDENTITY_ERROR` or `CERT_REVOKED`. | Check that the callee runs and is healthy, and the NetworkPolicies between the two. |
| `answered though the policies now deny it` | The policies deny the call, and it was answered. | An enforcer may be missing, or a policy is newer than the figures. |
| `traffic seen, and a policy allows it` | A policy covers the call and does not deny it. This includes a call Istio lets in because no ALLOW policy selects the callee: nothing refuses it, and no policy is named as allowing it (the paragraph under this table says how netatlas words it). | Nothing. |
| `traffic seen, no policy covers it` | No policy covers the call. | Add a policy if the call should be limited. |
| `allowed by a policy, no traffic seen` | The policies allow the pair and no call was seen. This is the idle edge ([Allowed, but no traffic](#allowed-but-no-traffic)). It includes a pair Istio lets in because no ALLOW policy selects the callee, and it is drawn only where neither the NetworkPolicies nor Istio's policies refuse the pair. | Nothing is broken: a policy allows a call that was not seen. |

The legend has eight lines for ten marks. An idle edge with no calls in the last 5 minutes and one with none in the last 24 hours share the line `allowed by a policy, no traffic seen` and the same dotted line, and an edge that is `not measured` is drawn in the grey of the line `not compared with the policies, or not measured`. With Compare with policies off, an edge has no mark: the legend has one line, `traffic seen`, and the idle edges are left out, because nothing was measured on them.

A policy covers a call when a NetworkPolicy restricts the caller's egress or the callee's ingress, or when an Istio AuthorizationPolicy that the callee's proxy enforces applies to the callee. The policies deny a call when a NetworkPolicy restricts either side and admits no port between the two workloads, or when Istio denies it.

Istio denies a call when an ALLOW policy applies to the callee and no rule admits the caller, or when a DENY rule matches the caller. A callee with only DENY policies lets in every caller that no DENY rule names. Istio's own order says why: a matching CUSTOM policy that denies refuses the request, then a matching DENY policy refuses it, and then, where the workload has no ALLOW policy, the request is allowed; otherwise a matching ALLOW policy must allow it, or the request is refused. A CUSTOM or DENY policy allows nothing, so netatlas never names one as what allows a call. Where no ALLOW policy selects the callee, it says so in words wherever it says what allows a call (the workload panel of the Policy map, the spoken labels of both maps, and What stands out): `no ALLOW policy selects <callee>, so Istio lets in every request that <policies> do not refuse`. The `<policies>` are the CUSTOM and DENY policies that may refuse some of the call's requests, with `does not refuse` for one of them, and the panel says `it` for the callee. On the Traffic view, for a pair with no Istio edge and no NetworkPolicy that lets it in, they are the CUSTOM and DENY policies that select the callee. In ambient mode the same holds for a callee with only CUSTOM policies, which ztunnel ignores. A 403 alone does not make `refused by Istio`: Envoy has no response flag for an access-control denial, and an application may answer 403 itself, so the policies must deny the call as well. ztunnel does say it outright: the callee's ztunnel records `DENY`, while the caller's ztunnel records the same refusal as `CONNECT`. Between sidecars nothing says it: Envoy's network filter closes a connection that an AuthorizationPolicy refuses and sets no response flag, so netatlas reads the refusal from the figures. A pair with no requests, closed connections and no response byte, that Istio's own rule denies, is `refused by Istio`, unless every closed connection carried one of the failure flags above, which reads `refused by the network` first. This rule comes from one measurement of plain TCP between two sidecars ([What 0.2.0 leaves out](todo.md)).

### Allowed, but no traffic

netatlas also draws, dotted, each pair the policies allow that has no traffic edge, and labels it. It uses the `recent` query to say how long nothing was seen:

- `no traffic, 24 h` when the pair is not among the pairs of the last 24 hours. Its spoken label says `allowed by a policy, no calls recorded in the last 24 hours`, and What stands out lists it as "Allowed, not used".
- `no traffic, 5 min` when the pair had calls in the last 24 hours, before the `recent` query has answered once, or while its last answer is more than 30 minutes older than the figures ([How often](#how-often)). Its spoken label says `allowed by a policy, no calls in the last 5 minutes`, and What stands out does not list it.
- `not measured` for an edge to an ambient destination in a cluster that runs waypoints. A call through a waypoint names the waypoint as its destination, so the calls may have gone through it, and netatlas claims neither calls nor their absence. Its spoken label says `allowed by a policy, traffic not measured`, and the edge carries the note `depends: traffic through waypoints is not attributed yet`.
- `not measured` for a pair the NetworkPolicies allow on UDP ports only (no TCP and no SCTP port), whatever Istio policy also admits it, because the NetworkPolicies let nothing else through: Istio's proxies do not carry UDP, so calls of that pair have no figure. A pair that only Istio's policies cover, with no NetworkPolicy on either side, is open on every port and stays measured. Its spoken label says the same as the one above, the edge carries the note `UDP only: Istio does not measure UDP`, and What stands out does not list it.

Where Istio lets the call in only because no ALLOW policy selects the callee, the spoken label of the Traffic map says that in place of `allowed by a policy`, on a seen call marked `traffic seen, and a policy allows it` too: `no ALLOW policy selects <callee>, so Istio lets in every request that <policies> do not refuse`, or, when a NetworkPolicy lets the call in as well, `allowed by a policy, and no ALLOW policy selects <callee>, so Istio lets in every request that <policies> do not refuse`. The text of the bullets above follows it after a comma, for example `..., so Istio lets in every request that deny-all does not refuse, no calls recorded in the last 24 hours`. A CUSTOM or DENY policy allows nothing, so it is named only as not refusing the call (the words are in [The marks](#the-marks)).

netatlas draws no idle edge in these cases:

- A pair whose caller is not in the mesh. netatlas attributes a call only to a caller with a proxy, so it cannot tell whether such a caller made one.
- A pair whose destination is kube-dns. Names resolve over UDP, which the Istio metrics netatlas reads do not count, so nothing says whether kube-dns was called.
- A pair to or from the Internet node. The 24-hour history names workloads only, so an allowed way out that nobody used is not drawn ([What 0.2.0 leaves out](todo.md)).
- A pair that either layer refuses: a NetworkPolicy that admits no port between the two workloads, or Istio's policies, even when the other layer would let it in. A call seen on such a pair and answered is marked `answered though the policies now deny it`, so an idle edge and a seen call never disagree.
- Any pair, while netatlas may not read NetworkPolicies or AuthorizationPolicies: the kind it may not read could refuse any pair, so netatlas cannot say that the policies allow it.

### What stands out

The panel beside the map lists the edges that need a look, in groups. A group with no edge is left out, and when no group is left the panel says `Nothing stands out.` Each entry says what happens and, under it, why it is listed. A workload is named by its name, or as `<namespace> / <name>` when another workload of the cluster has the same name. The panel does not follow the map's filters: it lists calls whose ends are in namespaces the map hides (by default `kube-*` and Istio's root namespace), and it reads the same with Compare with policies off, when the map shows no mark. While netatlas may not read a policy kind, the groups Traffic no policy covers and Allowed, not used stay empty, because without the policies netatlas cannot say that no policy covers a call or that one allows a call nobody made; Errors still lists the failures it measured. The groups come in this order:

| Group | Lists | The entry reads | The reason it gives |
|---|---|---|---|
| Traffic no policy covers | Edges drawn as `traffic seen, no policy covers it`. | `<caller> calls <callee>, <figures>.` | `No policy restricts calls out of <caller> or into <callee>.` |
| Allowed, not used | Edges with `no traffic, 24 h`. | `<caller> may call <callee> on <port>.` for a NetworkPolicy edge, `<caller> may call <callee>: <what Istio allows>.` for an Istio edge | `Allowed by <policies>. No calls recorded in the last 24 hours.` |
| Errors | Edges that are allowed, uncovered or answered though denied, or left not compared because netatlas may not read a policy kind, with at least 1% of requests answered 5xx. | `<caller> calls <callee>: <share> of requests fail.` | `<n> requests a second over the last 5 minutes.` |
| Refused calls | Edges drawn as `refused by Istio` or `refused by the network`. | `<caller> calls <callee>: refused by Istio.` or `... refused by the network.` | `Every answer was a 403, and the Istio policies on <callee> do not allow <caller>.` or `ztunnel closed every connection with DENY.` or `Every connection closed with nothing sent back, and the Istio policies on <callee> do not allow <caller>.` or `No call got an answer: the connection failed, or no upstream was healthy.` |
| Answered though the policies deny it | Edges drawn as `answered though the policies now deny it`. | `<caller> calls <callee>, <figures>.` | `The policies deny this call, yet it was answered: an enforcer may be missing, or a policy is newer than the figures.` |

The reason of an Allowed, not used entry names what lets the call in: the NetworkPolicies and the Istio ALLOW policies that allow it. Where no ALLOW policy selects the callee it reads `No ALLOW policy selects <callee>, so Istio lets in every request that <policies> do not refuse. No calls recorded in the last 24 hours.`, or, when a NetworkPolicy lets the call in as well, `Allowed by <NetworkPolicies>, and no ALLOW policy selects <callee>, so Istio lets in every request that <policies> do not refuse. No calls recorded in the last 24 hours.` The group lists a pair only where neither the NetworkPolicies nor Istio's policies refuse it.

The figures in an entry are in words: `6 requests a second, 2.1 percent errors`. The first group is drawn in the colour the map uses for workloads no policy selects, and the last two in the warning colour. Notes of two kinds can follow the groups ([the notes](#the-internet-node-and-the-notes-on-edges)): one for each workload outside the mesh that traffic reaches, and one for the callers outside the mesh when that node is drawn.

### The Internet node and the notes on edges

Istio records nothing for the hop from a client outside the cluster into an ingress gateway. So each ingress gateway that has a proxy and forwarded something in the last 5 minutes gets an edge from the Internet node, carrying what the gateway forwarded: the sum of its own outgoing figures. A gateway that forwarded nothing gets no edge. Its note is `what the gateway forwarded: Istio records nothing for the hop into a gateway`. A gateway without a proxy gets no such edge, because nothing measured what it forwarded. netatlas takes a pod for an ingress gateway when it carries the label `istio=ingressgateway`, or a label with the key `gateway.networking.k8s.io/gateway-name`, unless it is a waypoint or its proxy runs as a sidecar. A pod is an egress gateway when it carries `istio=egressgateway`, unless its proxy runs as a sidecar. A pod whose proxy runs as a sidecar is never taken for a gateway or a waypoint, whatever labels it carries.

An edge's notes come after its figures and mark in the label a screen reader reads for it, for example `From Internet to ingressgateway, 6 requests a second, what the gateway forwarded: Istio records nothing for the hop into a gateway`. A workload in these labels is named as What stands out names it. A note on the page is a line under the groups of What stands out. A note is one of these:

| Note | Where it comes from |
|---|---|
| `through the egress gateway: Istio splits this link in two` | The call went to an egress gateway. |
| `through a waypoint: figures per destination need the waypoint's metrics, not read in 0.2.0` | The destination is a waypoint. |
| `TCP only: no waypoint` | An ambient destination with no requests: ztunnel sees connections only. |
| `the callers are outside the mesh, so netatlas cannot tell which workloads they are` | The caller has no proxy and no name. |
| `the callers are in another cluster of the mesh, so netatlas does not compare the call with this cluster's policies` | The caller is in another cluster of the mesh: the edge is drawn from the Internet node. |
| `UDP only: Istio does not measure UDP` | An idle edge to a pair the NetworkPolicies allow on UDP only, whatever Istio policy the pair has. |
| `depends: netatlas's role may not read NetworkPolicies`, `... AuthorizationPolicies` or `... NetworkPolicies and AuthorizationPolicies` | A measured pair left not compared because netatlas may not read that kind. |
| `not running now` | The metrics name a workload netatlas does not see in the cluster. |
| `depends: traffic through waypoints is not attributed yet` | An idle edge to an ambient destination in a cluster with waypoints. |
| `<workload> is not in the mesh, so its traffic is measured from the callers' side only.` | A workload with no proxy that traffic reaches. |
| `Callers outside the mesh are drawn as one node: they have no proxy, so Istio cannot name them.` | The node `Callers outside the mesh` is drawn. |

## The Outbound view

The Outbound view shows what leaves a cluster for domains and IPs outside it. Choose Outbound in the views column, under Network. It lists one cluster, or, with All clusters chosen, every cluster in name order under its own heading. Above the table it says `What leaves <cluster>: what the policies allow out, and what Istio measured over the last 5 minutes.` Under each cluster's note it says `Cannot read <Kind>: netatlas's role does not allow it.` for each of Namespaces, Pods, ReplicaSets, Jobs, NetworkPolicies, AuthorizationPolicies, ServiceEntries and Sidecars that netatlas may not read, because a kind it may not read reads as none, and no verdict may rest on that.

The table sits in a scroll box named `Destinations of <cluster>`, which takes the keyboard focus so that the keyboard can scroll it, and each row is named by its destination. It has four columns, and the policies and the metrics stay side by side:

- **Destination**: where calls go. [The rows](#the-rows) lists each kind.
- **Ports**: the ports of a ServiceEntry host, or the ports the rules open to an address range. The other rows leave it empty.
- **May call**: what the policies allow out. Two layers each give their own verdict for a workload, and netatlas never merges them: a NetworkPolicy decides by IP address, and Istio decides by host name. A host name and an address range are different kinds of rule, and netatlas cannot join them. Workloads that share both verdict lines are one group. The view prints the names of the group (`<namespace> / <name>`), the first twelve and then `and <n> more`, and under them the two lines once: `NetworkPolicy: <verdict>` and `Istio: <verdict>`.
- **Do call**: what workloads actually call, from the metrics, each with its figure per second: requests (`52 req/s`) or, for TCP and TLS, which carry no requests, bytes (`18 kB/s`). The busiest caller comes first, by its requests plus its closed connections. The Outbound view reads only the caller's report (`reporter="source"`), because only the caller's proxy saw where a call left the cluster. A caller netatlas does not see in the cluster is listed here by name with no verdict under May call, and a caller Istio cannot name is `Callers outside the mesh`.

Under May call, the list of a ServiceEntry host starts with the workloads that call it, then the other workloads that a rule of either layer lets call it. Every other workload that neither layer blocks is counted, not named: `and <n> other workloads that may call it`. Naming them would repeat, on every host's row, the workloads that may call any host, which the row `Any other address or domain` names once.

Do call is empty when netatlas has no figures: the cluster names no Prometheus (the column heading then says `No traffic source for <cluster>: its registry entry names no Prometheus.`), or Prometheus has not answered yet. Once there are figures, a destination nobody called says `none`. The rows of address blocks and the row `Any other address or domain` have no Do call. An address block's stays empty because Istio records no address, so a call to a block is never counted and `none` would say nobody called it. The row `Any other address or domain` states what workloads may do, and each call is on the row of where it went.

The search box in the header (`workload or destination`) keeps the rows whose destination contains what you type, or that list a matching workload under May call or Do call. It ignores case and the spaces around the text, and it keeps a row whole. On the row `Any other address or domain` it keeps only the workloads that match, unless the destination itself matches, and the row goes when none does. With no match the page says `No destination matches the search.`, and a cluster with nothing outside it says `No destination outside the cluster.` It says so only when netatlas could read every kind the view rests on: when a kind could not be read and no row is made, the page shows no sentence, and the `Cannot read` lines above it say why.

### The rows

The rows come in this order: hosts, busiest first; then the rows of calls Istio cannot name or sent elsewhere, in the order of the table below; then the address ranges, by text; then the one row for the workloads that may call any address. A row is one of these:

| Destination | One row for | Ports | The note under the destination |
|---|---|---|---|
| A host as its ServiceEntry writes it, a wildcard host as `*.example.com` (a call's Host header matches it whatever its letter case) | each host | each port of its ServiceEntries, as `HTTP 8080` | none |
| A host seen in calls that no ServiceEntry names | each host | empty | none |
| `Blocked by REGISTRY_ONLY: <host>`, or `Blocked by REGISTRY_ONLY` when no host was named | each caller | empty | `Istio refused these calls: the host is not registered.` |
| `Unregistered TLS or TCP traffic` | each caller | empty | `Istio keeps no host, SNI or IP for these calls, so netatlas cannot name the destination.` |
| `Unattributed traffic` | each caller | empty | `ztunnel recorded no destination for these calls.` |
| `Through the egress gateway <namespace> / <name>` | each caller | empty | `Istio splits this link in two: the gateway's own calls are listed under their hosts.` |
| `Another cluster of the mesh (<cluster>)` | each cluster | empty | none |
| An address block an egress rule names, as `203.0.113.0/24` or `203.0.113.0/24 except 203.0.113.128/25` | each block | the ports the rules open to it, as `TCP 443`, `every TCP port` or `every port` | `Istio records no address, so calls to this range are not counted here.` |
| `Any other address or domain` | the whole cluster | empty | `What these workloads call is listed in the rows above.` |

An address block's May call lists the workloads whose rules name it, with the NetworkPolicy line `allowed by <policy> (<block>) on <ports>`, for example `on TCP 443` or `on every port`, and their Istio layer. The ports are the ones that workload's own rules open to the block; the Ports cell of the row is the union of every workload's. Calls to a block are not counted, because Istio records no address, so its Do call is empty. While netatlas may not read NetworkPolicies, the rows of address blocks are not made, and neither is the row `Any other address or domain`: without the policies netatlas knows no block, and no workload that may call any address. The row `Any other address or domain` lists, as one May call, every workload whose NetworkPolicies leave every address open and whose Istio layer is `any domain` or `not in the mesh`.

### The Internet node's short list

Choose the Internet node on the Policy map and its side panel, `Outside the cluster`, shows the short form of the Outbound view:

- `Most called, last 5 minutes`: the ten destinations with the most calls, each once with the figures of all its callers added, as the Outbound view reads them. A destination with the same text on several rows, such as `Unregistered TLS or TCP traffic` (a row for each caller), is one entry. The entries are in order of requests plus closed connections per second, highest first, and then of bytes. A destination that only moves bytes is listed too, with its bytes, so a long TCP or TLS connection is not left out. The list says `None.` when nothing was called, and is absent while the cluster has no figures.
- `<n> destinations named by the policies`: the ServiceEntry hosts and the address ranges the policies name.
- The link `Open the Outbound view`.

The panel starts with the same line about the traffic source as the other pages: that there is none, that it is being read, or that it is unavailable.

### The NetworkPolicy layer

NetworkPolicy cannot name a domain. While netatlas may not read NetworkPolicies, every NetworkPolicy line reads `depends: netatlas's role may not read NetworkPolicies`. Otherwise, for a workload it says:

- `any address: no NetworkPolicy restricts its egress` when nothing restricts its egress side.
- Otherwise the address ranges (`ipBlock`, minus `except`) and ports its egress rules allow.

For a ServiceEntry host, netatlas judges the address and port the sidecar connects to, because that is what a NetworkPolicy sees leave the pod:

| ServiceEntry `resolution` | The address netatlas judges |
|---|---|
| `NONE` (the default) | The entry's `addresses`: the sidecar passes the call through to the address the app dialled. |
| `STATIC` | The addresses of the entry's endpoints. |
| `DNS` and the other resolutions | None: what a name resolves to is not known, so the NetworkPolicy line cannot name an address. The table of verdicts below says what the policies then give. |

Istio serves every port of an entry, so netatlas judges every port. The port is the endpoint's own port for the entry port's name, else the entry port's `targetPort`, else its `number`. netatlas judges the ports one by one and compares their outcomes, the first column of the table below. Where every port gives the same text, that is the verdict. Where every port has the same outcome and it is not `depends`, the verdict is that outcome, with each port's text once, in the entry's order, joined as `<a> and <b>`, or `<a>, <b> and <c>` for three, for example `allowed by <policy> (198.51.100.0/24) and allowed by <other policy> (198.51.100.0/24)`, or `blocked by <policy>: no egress rule admits TCP 80 to an address outside the cluster and blocked by <policy>: no egress rule admits TCP 443 to an address outside the cluster`. Where the outcomes differ, it is `depends on the port it calls`, because each call goes to one of them. A port whose `protocol` is `UDP` (in any case) is judged as UDP, so a policy that opens only TCP on it blocks the call; every other protocol, HTTP, TLS and the rest, is judged as TCP. A caller without a sidecar is judged as for a name whose address is unknown, on each of the entry's own port `number`s, because nothing redirects its call to the `targetPort` or an endpoint's port.

When two ServiceEntries name one host, netatlas judges the one the caller's namespace sees: an entry is seen when its `exportTo` admits the namespace (the rule is in [The Istio layer](#the-istio-layer)), and the entry in the caller's own namespace comes first, as in Istio. A namespace that sees none of them is judged as a caller without a sidecar.

The verdict reads:

| Verdict | Text |
|---|---|
| allowed | `allowed by <policy> (<range>)`; on a row of an address block, `allowed by <policy> (<range>) on <ports>` |
| any | `any address on <ports> (<policies>)`, for a rule with no peers |
| blocked | `blocked by <policies>: no egress rule admits <addresses>`, or `... admits <protocol> <port> to an address outside the cluster`, or `blocked: its egress admits no address outside the cluster (<policies>)` |
| depends | `depends on the address the name resolves to (<policies>)`, `depends on which address it calls: no egress rule of <policies> admits <addresses>`, `depends on which address of <range> it calls (<policies>)`, `depends on the port it calls (<policies>)`, or `depends: netatlas's role may not read NetworkPolicies` |

### The Istio layer

Istio's layer is for workloads with a sidecar. netatlas finds the Sidecar that governs a workload, and then its outbound mode, in this order, and the first one found decides:

1. The Sidecar in the pod's namespace whose `workloadSelector` matches the pod (the oldest first).
2. That namespace's Sidecar without a selector.
3. The Sidecar without a selector in Istio's root namespace.
4. The mesh config: the key `mesh` of the ConfigMap `istio` in the namespace istiod runs in, which netatlas takes to be Istio's root namespace (`istio-system` unless the cluster's `istio.rootNamespace` says otherwise). A ConfigMap with no data reads as Istio's defaults. Istio takes a key of the mesh config under its JSON name or its proto name (`outboundTrafficPolicy` or `outbound_traffic_policy`), and the JSON name wins when both are there; netatlas reads both.
5. Istio's default, `ALLOW_ANY`.

Istio uses one Sidecar and the next one down never fills in what it leaves out. A Sidecar that has no `outboundTrafficPolicy` leaves the mode to the mesh config (step 4, then step 5), and its own `egress` hosts still apply. A Sidecar that sets `outboundTrafficPolicy` without a `mode` means `REGISTRY_ONLY`, because it replaces the mesh's policy instead of adding to it.

| Outbound mode | The verdict |
|---|---|
| `ALLOW_ANY`, `ALLOW_ANY_DYNAMIC_DNS` | `any domain (<mode>, <source>)`, where the source is `Sidecar <namespace>/<name>`, `the mesh config` or `Istio's default`. |
| `REGISTRY_ONLY` | `only the hosts listed (REGISTRY_ONLY, <source>)`. A host is `listed: REGISTRY_ONLY admits it (ServiceEntry <namespace>/<name>)` or `blocked: REGISTRY_ONLY, and no ServiceEntry visible to <namespace> lists it`. |

Under `REGISTRY_ONLY` the listed hosts are the hosts of the ServiceEntries visible to the workload's namespace, narrowed by the Sidecar's `egress[].hosts`. A ServiceEntry is visible by its `exportTo`; an empty `exportTo` takes the mesh's `defaultServiceExportTo`, and everywhere when that is not set. A ServiceEntry admits its hosts whatever its `location`, `MESH_EXTERNAL` or `MESH_INTERNAL`: the location changes how Istio treats the backends, not what `REGISTRY_ONLY` admits.

Three workloads get an answer that is not a mode:

| Workload | The verdict |
|---|---|
| A pod without a proxy | `not in the mesh` |
| An ambient workload | `any domain: ztunnel passes unknown traffic through`. ztunnel has no outbound policy, so an ambient workload has no `REGISTRY_ONLY` and is never "blocked" by the mesh's mode. |
| A gateway or a waypoint | `depends: a gateway or waypoint forwards only what its routes name, and netatlas does not read them`. Neither a Sidecar nor the mesh's mode governs them. |

### What "depends" means

"Depends" means netatlas cannot evaluate the rule, so it says why instead of giving a verdict it cannot prove. Each reason, and what to do:

| Layer | The reason | What it means and what to do |
|---|---|---|
| NetworkPolicy | `depends on the address the name resolves to (<policies>)` | netatlas knows no address for the destination, and the policies allow address ranges, so which address the call goes to decides whether it passes. This is the case for a ServiceEntry with `DNS` resolution (or `STATIC` with no endpoints, or `NONE` with no addresses), for a caller without a sidecar, and for every row that names no ServiceEntry: a host seen only in calls, and the rows `Unregistered TLS or TCP traffic`, `Blocked by REGISTRY_ONLY`, `Unattributed traffic`, `Through the egress gateway <namespace> / <name>`, `Another cluster of the mesh (<cluster>)` and `Any other address or domain`. |
| NetworkPolicy | `depends on which address it calls: no egress rule of <policies> admits <addresses>` | The policies admit some of the entry's addresses and refuse others. Calls to the admitted ones pass: a `STATIC` entry spreads its calls over its endpoints, and a `NONE` entry passes the address the app dialled. |
| NetworkPolicy | `depends on which address of <range> it calls (<policies>)` | The entry's address is a range, and the egress rules admit only a part of it: calls to the admitted addresses of the range pass and to the others do not. |
| NetworkPolicy | `depends on the port it calls (<policies>)` | netatlas does not know which port a call uses, and the policies admit the destination on some ports only. For a ServiceEntry the cause is endpoints that use different ports, or ports of the entry whose outcomes differ, for example one blocked and one allowed. On a row that names no ServiceEntry no port is known, so it appears for a workload whose only egress rules have no peers and name ports, for example a policy that allows every address on TCP 443 only. |
| NetworkPolicy | `depends: netatlas's role may not read NetworkPolicies` | The role lacks the rule for NetworkPolicies, and a kind netatlas may not read reads as none. Apply the rules of [The role](#the-role). |
| Istio | `depends: a gateway or waypoint forwards only what its routes name, and netatlas does not read them` | The routes of the gateway or waypoint decide, and netatlas does not read them. |
| Istio | `depends: netatlas's role may not read Sidecars` | The role lacks the rule for Sidecars, which could set either mode or limit the hosts. Said for every workload with a sidecar. Apply the rules of [The role](#the-role). |
| Istio | `depends: netatlas's role may not read ServiceEntries` | The role lacks the rule for ServiceEntries. Said under `REGISTRY_ONLY`, where the ServiceEntries decide which hosts a workload may call. Apply the rules of [The role](#the-role). |
| Istio | `depends: the ConfigMap istio is missing` | The namespace netatlas takes to be the root namespace (`istio-system` unless the cluster's entry says otherwise) has no ConfigMap `istio`. If istiod runs in another namespace and that is also Istio's root namespace, set `istio.rootNamespace` in the cluster's entry to it. Where istiod's namespace and Istio's root namespace differ, netatlas cannot read the mesh config yet ([What 0.2.0 leaves out](todo.md)). |
| Istio | `depends: netatlas's role may not read the ConfigMap istio` | The role lacks the rule for that ConfigMap. Apply the rules of [The role](#the-role). |
| Istio | `depends: the mesh config is not valid YAML` | The `mesh` key of the ConfigMap is not valid YAML or not a mapping, or its `outboundTrafficPolicy` or its `serviceEntryVisibility` is not one netatlas can read (`serviceEntryVisibility` must be a mapping of settings). |
| Istio | `depends: the cluster serves no networking.istio.io API` | Istio's CustomResourceDefinitions are not installed, so there are no ServiceEntries or Sidecars to read. |
| Istio | `depends: the pod runs Istio revision <revision>, whose mesh config netatlas does not read` | A pod of another revision reads the ConfigMap `istio-<revision>`, which netatlas does not read. |
| Istio | `depends: the mesh config sets outboundTrafficPolicy without a mode` | Istio's source leaves open whether it reads this as `REGISTRY_ONLY` or keeps `ALLOW_ANY`. netatlas has not tested which, so it does not guess. Set a `mode`. |
| Istio | `depends: the mesh config sets the outbound mode <mode>, which netatlas does not know` and `depends: the Sidecar <namespace>/<name> sets the outbound mode <mode>, which netatlas does not know` | A mode netatlas has no rule for. |
| Istio | `depends: istiod also reads the ConfigMap <name>, which netatlas does not read` | A pod labelled `app: istiod` has the environment variable `SHARED_MESH_CONFIG` set to a ConfigMap name, in one of its containers. istiod loads that ConfigMap from the namespace it runs in as a second mesh config, and the ConfigMap `istio` takes precedence; so what `istio` leaves out may be set there. netatlas reads only a literal value of the variable, not one given by `valueFrom`. |
| Istio | `depends: the mesh sets serviceEntryVisibility for sidecars, which netatlas does not evaluate` | The mesh config's `serviceEntryVisibility` sets `applyToSidecars` to anything but `false`, and either a `defaultVisibility` other than `PUBLIC` (an unset or `VISIBILITY_UNSPECIFIED` default counts as `PUBLIC`) or at least one policy. istiod then narrows which ServiceEntries a sidecar sees: `NAMESPACE` keeps an entry to its own namespace, `NONE` hides it, and a policy picks entries by the labels of their namespace. Without `applyToSidecars` only ztunnel and waypoints apply the setting, and netatlas does not say anything about it. Istio reads `yes`, `y` and `on` as true, like `true`, but netatlas's YAML reader keeps them as words, so netatlas treats every value of `applyToSidecars` except `false` and none as set: `depends`, also for `no` and `off`, which Istio reads as false. |
| Istio | `depends: the Sidecar <namespace>/<name> lists egress hosts netatlas does not evaluate (<host>)` | An egress host other than the plain `namespace/host` forms, for example one with `~`. |
| Istio | `depends: the Sidecar <namespace>/<name> limits an egress listener to one port` | An egress listener of the Sidecar names a port. |

### What workloads do call

netatlas reads the host from `destination_service`. It reads `destination_service_name` only to recognise `PassthroughCluster` and `BlackHoleCluster`, and, together with `destination_service`, to tell an unattributed call (both `unknown`) from an unregistered one, because that label means different things in sidecars, ztunnel and waypoints. A call goes to one of these:

- **A ServiceEntry host.** A wildcard entry reports the wildcard text itself, for example `*.example.com`. Istio labels a call to such a host with a workload name of its own making, in the entry's namespace: `<entry name>-<index>` for each inline endpoint, or the entry's own name for the one endpoint of a DNS entry without endpoints. No pod has that name, so netatlas reads a call that names a workload it does not see, and a service that is not a service of this cluster, as a call to that host. A call's host matches an entry's host whatever its letter case, and the row shows the host as the entry writes it. The edge goes to the Internet node, and the caller is listed on the host's row of the Outbound view. A call that names a workload it does not see and a service of this cluster is a workload `not running now`.
- **A host name seen in plain HTTP to an unregistered host.** The name is the Host header, without its port. A call to a host of a `MESH_INTERNAL` ServiceEntry is listed the same way, as a seen host, because that entry stands for a service inside the mesh and has no row of its own.
- **Unregistered TLS or TCP traffic**, one row for each caller. Istio keeps no host, SNI or IP in any label for it, so netatlas cannot name the destination.
- **Blocked by REGISTRY_ONLY**, for calls Istio sent to `BlackHoleCluster`.
- **Unattributed traffic**, in ambient mode, when every destination label is `unknown`.
- **Through the egress gateway**, for a call to an egress gateway.
- **Another cluster of the mesh** (`<destination_cluster>`), for a caller's report whose `destination_cluster` differs from its `source_cluster` (both known), even when this cluster has a workload of the same namespace and name, and even when the host it was called by is not a service of this cluster. Such a call is part of the caller's edge to the Internet node and is never marked "not running now". The opposite direction is read from the callee's report: a call into this cluster from a caller whose `source_cluster` differs from the `destination_cluster` is drawn from the Internet node to the workload it reached, with the note `the callers are in another cluster of the mesh, so netatlas does not compare the call with this cluster's policies`.

Calls to the cluster's own services, hosts ending in `.svc.<cluster domain>`, are not outbound. The cluster domain is the cluster's `clusterDomain` value, `cluster.local` by default.

## What Istio cannot tell

- **Unregistered TLS and TCP.** For TLS or TCP to a destination no ServiceEntry names, Istio records no host, SNI or IP in any metric label. The Outbound view shows one row for each caller, `Unregistered TLS or TCP traffic`, and cannot say where the calls went. A ServiceEntry for the destination names it: calls to a registered host carry the host. Istio's Telemetry API can add labels taken from Envoy's attributes, which may name such a destination. netatlas groups by the labels listed above only, so it does not read them yet ([What 0.2.0 leaves out](todo.md)).
- **Ambient without a waypoint.** ztunnel reports TCP only, so the edge has bytes and connections and no requests or error share, and says `TCP only: no waypoint`. In ambient mode a call to a host that no label names is unattributed traffic, not unregistered. ztunnel names the destination of a call only when it knows a service or workload at the address the client connected to; otherwise it passes the connection through with no destination to name. For a ServiceEntry host, that address is one of the entry's `addresses`, or, for an entry that has none and whose `resolution` is not `NONE`, an address that istiod allocates and writes into the entry's status. ztunnel's DNS proxy answers with it when the pod's DNS goes through ztunnel. Istio turns DNS capture for ambient pods and istiod's address allocation on by default. A call to an entry with no `addresses` is unattributed when either is off, when the entry's `resolution` is `NONE`, or when the entry carries the label `networking.istio.io/enable-autoallocate-ip` set to `false`, because ztunnel then has no address to match.
- **Traffic behind a waypoint.** ztunnel names the waypoint as the destination, so the edge is drawn to the waypoint and carries its note. Figures per destination need the waypoint's own metrics, which netatlas does not read yet.
- **Egress gateways split the link.** With an egress gateway, "workload X calls host Y" is not in one series: X calls the gateway, and the gateway calls Y. netatlas shows both edges and says so. It does not join them.
- **DNS over UDP is not measured.** The Istio metrics netatlas reads do not count DNS over UDP: a sidecar does not proxy UDP, and the DNS proxy in ztunnel counts the requests it answers in its own metrics, which netatlas does not read. A call to kube-dns over UDP therefore never shows, and netatlas draws no idle edge to kube-dns, so it never calls one unused.
- **Callers outside the mesh.** A caller with no proxy is seen only by the callee's proxy. A sidecar cannot name it, so netatlas draws one node, `Callers outside the mesh`, with no workload name. In ambient mode ztunnel names such a caller, and netatlas draws it as its own workload. A workload outside the mesh is measured from its callers' side only, and the page says so.
- **Gateways are recognised by label.** An ingress edge is drawn for any pod with the label key `gateway.networking.k8s.io/gateway-name` (waypoints excepted), so a Gateway API egress gateway, which carries the same key, is drawn as if it were an ingress one. A gateway installed under other labels is drawn as an ordinary meshed workload, because a proxy role of `router` cannot tell an ingress gateway from an egress one. A pod whose proxy runs as a sidecar is never taken for a gateway or a waypoint, whatever labels it carries.

## The role

netatlas 0.2.0 reads three more things than the first release did, and the chart's read role grants exactly them:

- ServiceEntries and Sidecars (`networking.istio.io`): get, list and watch.
- The ConfigMap named `istio` and no other ConfigMap: get, list and watch, with `resourceNames: [istio]`. RBAC lets a list or a watch read a ConfigMap named in `resourceNames` only when the request selects `metadata.name=istio`, and netatlas's does.

netatlas still never reads Secrets.

[deploy/reader-access.yaml](../deploy/reader-access.yaml) and the [Terraform example](../examples/terraform/eks-access) carry the same rules. A cluster read with a token or an EKS access entry that you set up before 0.2.0 needs them applied again. Until then the overview's list of what needs attention says `<cluster>: Cannot read ServiceEntries: netatlas's role does not allow it.` under Cannot read (and the same for Sidecars), the Policy map, the Traffic view and the Outbound view say `Cannot read ServiceEntries: netatlas's role does not allow it.` (and the same for Sidecars) too, and the Istio layer says `depends: netatlas's role may not read the ConfigMap istio`, `... Sidecars` or `... ServiceEntries`.

## Egress the mesh needs

An egress NetworkPolicy can keep a workload from something the mesh needs. netatlas lists such a workload on the overview under "Egress the mesh needs", as `<cluster>: <namespace> / <name> <text>`, and on the workload's panel, which starts the text with a capital. The text names the policies and is:

- **istiod.** A workload with a sidecar whose egress does not admit the istiod pods in Istio's root namespace on TCP 15012 reads `cannot reach istiod on TCP 15012 (<policies>). New pods do not become ready while these policies apply: their sidecar waits for configuration from istiod.` The sidecar starts, but Istio's readiness check for it fails until istiod has sent its first configuration. A workload that reaches istiod only through an `ipBlock` rule on that port gets the line too ([What 0.2.0 leaves out](todo.md)).
- **kube-dns.** A workload whose egress does not admit the pods labelled `k8s-app=kube-dns` on UDP 53 reads `cannot reach kube-dns on UDP 53 (<policies>). Names do not resolve.` Names resolve over UDP, so netatlas asks for UDP 53. It cannot tell which address answers DNS (NodeLocal DNSCache listens on a link-local one), so an address rule that admits the port counts as reaching it.

To fix a line, add an egress rule that admits that port to those pods. netatlas skips a check when it sees no istiod or kube-dns pods, for example with an external control plane, and it never checks the target's own pods.
