# What 0.2.0 leaves out

netatlas 0.2.0 shows the network policies of your clusters, edits NetworkPolicies, and shows the traffic Istio records and what leaves each cluster. This page lists what it does not do yet.

## Later releases

- A workload that only DENY or CUSTOM AuthorizationPolicies select. netatlas counts it as having a policy, so the Overview does not count it under workloads no policy selects and the map does not mark it open, and the Policy map draws Istio lines to it only from callers a rule may match (`src/model/istio.ts`, where a workload with no ALLOW policy gets an edge only when a DENY or CUSTOM rule may match the caller). Istio lets in every request those policies do not refuse, because its evaluation rules say "If there are no ALLOW policies for the workload, allow the request." (istio/api `security/v1beta1/authorization_policy.proto`). A cluster with a DENY policy for the whole mesh therefore shows no workload as "no policy". This is the first thing planned after 0.2.0, the first item of 0.3.0: it changes what "open" means on the Overview, the map, the panel and the legend, so it is its own designed task.
- Findings from StackRox and Falco (0.3.0).
- The agent (0.4.0), which adds every domain and IP a workload calls, read from DNS answers and connections.

## Reading more sources

- Amazon Managed Prometheus, which signs requests with SigV4.
- Reading Prometheus through the API server's service proxy, which needs no Prometheus credentials.
- Telemetry-added labels that would name unregistered TLS and TCP destinations ([What Istio cannot tell](traffic.md#what-istio-cannot-tell)).

## Reading clusters

- When a `token` cluster's token file goes bad while netatlas is reading the cluster, one cause gives two log lines: the reader's `netatlas: cluster <name>: Kubernetes API stopped: the token file holds a character an Authorization header cannot carry`, then the probe's `netatlas: cluster <name>: the token file holds a character an Authorization header cannot carry`. The probe's line is logged once until a check passes, and no test pins the retries.
- A token file that holds a space or a tab gets the reason `netatlas's token file holds a character an Authorization header cannot carry`, though an Authorization header carries both: Node's `http.validateHeaderValue` and `Headers` accept `Bearer abc def` and the same with a tab, and refuse a line break. netatlas rejects them because its check is stricter than a header's, visible ASCII only (a bearer token holds nothing else), so a file that holds the whole value `Bearer <token>` is told to look for a character the header would carry, when the cause is the space after `Bearer`. The log line and the error have the same words.
- With Pods refused, the Traffic view draws every workload its metrics name as `<namespace> · not running now`, under the line `Cannot read Pods`. The pods were not read, not found missing, so the words are wrong in that state.
- DaemonSets that netatlas may not read get no `Cannot read` line on the Policy map, the Traffic view and the Outbound view, and what they change there was not traced. The Overview shows `cannot read` for the enforcer and the Istio mode without them.

## The map

- Routing lines around boxes. On the Policy map and the Traffic view a line runs directly from a caller to what it calls, across any box in its way, and is drawn over that box: the line ends where its arrowhead is.
- Moving the map with the keyboard. Zoom In, Zoom Out and Fit View are buttons, and moving is by drag only. After a zoom, a keyboard user cannot reach the part of the map that is out of view, though every workload link on the Policy map still works and opens its panel.
- The maps on a phone. The map is fitted to a box about 325 px wide, an up or down drag scrolls the page, so a zoomed map moves up and down only by a drag that starts sideways, and the Outbound table is 860 px wide inside its scroll box. At 375 px the journeys check that the page does not scroll sideways and that the map is scaled down to fit its box; the rest was read from the code, not seen on a phone.
- The journeys' check of the scale of a map at 1440 by 900. The Traffic journey checks that the map fits its box at 60% or more, and Zoom In on both maps then waits for a scale above the one that was read. The read comes once the namespace checks pass, and those pass whether or not the browser has scaled the map, so it can come before the scaling: a read of 1.0 passes the 60% check, and Zoom In then waits for a scale above 1.0. The 375 px checks read no scale: they need every namespace box inside the map box, which holds only once the map is scaled down. Read from the code, not run.

## Traffic

- Attributing traffic through waypoints. A call through a waypoint is drawn to the waypoint and not attributed per destination.
- Recognising gateways by anything but their labels. The Internet edge and the egress note recognise gateways by label (`istio=ingressgateway`, `istio=egressgateway` and the Gateway API labels). A gateway installed under other labels is drawn as an ordinary meshed workload, because a proxy role of `router` cannot tell an ingress gateway from an egress one.
- A way out to the Internet that a policy allows and no workload used in the last 24 hours is not listed under "Allowed, not used". The Traffic view draws no idle edge to or from the Internet, because the 24-hour history names workloads only.
- A search box on the Traffic view. The Policy map and the Outbound view have one in the header, and the Traffic view has none.
- A text form of every edge of the Traffic view. The edges are images with a spoken label that cannot take focus, and on the Traffic view the boxes hold no link, so inside the map only the three buttons take focus. The Policy map names a text form beside it, the Traffic view has none, and What stands out lists only the edges that need a look.
- The 24-hour pairs carry no cluster label, so a call to or from the workload of the same name in another cluster of the mesh still counts as a recent call of the local pair. The pair then reads `no traffic, 5 min` and is not listed under Allowed, not used. A caller in another cluster is told apart in the 5-minute figures only.
- A workload whose pods differ (an ALLOW policy selects some of them, none selects the others) can read `no ALLOW policy selects <callee>` on its panel, the Policy map and the Traffic view, which is true of some of its pods only.
- A pair whose every connection closed with `CERT_REVOKED` reads `refused by the network` for up to five minutes, with the reason `No call got an answer: the connection failed, or no upstream was healthy.` ztunnel sets that flag when a certificate is revoked while the tunnel is up, and resets the streams in flight, so the connections may have carried data. The mark is kept, because the connections are cut below the application.
- A TCP pair whose callee resets its connections after answering can read `refused by the network`. A pair with no requests gets that mark when every closed connection of the window carries one of the failure flags (`UF`, `CONNECT`, `NETWORK_POLICY`, `TLS_FAILURE`, `H2_HANDSHAKE_FAILURE`, `IDENTITY_ERROR`, `CERT_REVOKED`), and the rule does not look at the response bytes, which the rule for `refused by Istio` on a closed connection does. ztunnel writes `CONNECT` for any error its mapping does not name, so a copy that ends in an error after the callee answered can carry it, and the page then gives the reason `No call got an answer: the connection failed, or no upstream was healthy.` Read from the source, not measured.
- SCTP counts as measured, so a pair the policies allow on SCTP only is listed under Allowed, not used after 24 hours. A search of Istio's iptables code for SCTP finds nothing, so Istio's proxies are not expected to carry it; this was read, not run.
- A call Istio refuses that sends nothing back reads `refused by Istio` also when the call was a one-way connection. The rule, and what was measured for it, are in the comment above it in `src/model/traffic.ts`.
- A TCP call refused between two sidecars that Istio names, as a call to a Service with a TCP port gives, goes over mutual TLS, and a refusal there was not measured. The rule for `refused by Istio` comes from plain TCP to a pod address, where Istio named neither end (the comment in `src/model/traffic.ts` has the numbers).
- A gateway that is called from another cluster of the mesh gets two lines from the Internet node: one for the callers in the other cluster, and one for what the gateway forwarded. netatlas does not merge them.

## Outbound

- Evaluating Sidecar `~` hosts, a mesh `serviceEntryVisibility` that sets `applyToSidecars` to anything but `false`, and other Istio revisions. Each reads "depends" today ([What "depends" means](traffic.md#what-depends-means)).
- A mesh config that istiod gets through `SHARED_MESH_CONFIG` given by `valueFrom` (a ConfigMap or Secret reference) is not read: only a literal value is. netatlas then reads the mesh config as if no second one existed, and does not say `depends`.
- netatlas reads the ConfigMap `istio` from the root namespace, and istiod reads it from the namespace it runs in. Where the two differ, every workload with a sidecar reads `depends: the ConfigMap istio is missing`, and no setting of netatlas can help.
- Any pod labelled `app: istiod`, in any namespace, can turn every sidecar's Istio line to "depends", and its `SHARED_MESH_CONFIG` text is shown in that line. The verdict only moves to "depends", never to a false "allowed".
- On an ambient callee, a CUSTOM AuthorizationPolicy is named as one that may refuse a call, and counts as a policy, though Istio gives ztunnel no CUSTOM policy (`pilot/pkg/serviceregistry/ambient/authorization.go`: "ztunnel does not support the %s action"). On a callee whose only policy is such a CUSTOM policy, a call is marked `allowed` and not `uncovered`.
- Host headers that differ only in letter case still make separate rows of seen hosts. Only the match to a ServiceEntry host ignores case.
- With REGISTRY_ONLY, a destination with no host name, and a host on the TCP port of a visible ServiceEntry that has resolution NONE and no addresses, can read "blocked" though Istio passes them.
- For a ServiceEntry port declared as UDP, the Istio line reads "listed", though Istio's sidecar does not handle UDP at all. Only the NetworkPolicy line decides such a call.

## Other kinds and enforcers

- Creating and deleting policies, and editing Istio policies.
- The Calico, Cilium and AdminNetworkPolicy kinds.
- kindnet as an enforcer. The example kind clusters run kindnet (`kindest/kindnetd:v20260820`), which blocks what NetworkPolicies do not admit, but netatlas recognises only Calico, Cilium and the AWS VPC CNI, so its Overview says `none found: policies may not be enforced` for them.
- Services.

## The test setup

- The EKS smoke run outside CI.
- The Overview's cluster table changes its line breaks when a cluster's age passes 10 s. It happens with the long text `none found: policies may not be enforced` at widths near 1440. On such a cluster the age passes 10 s in each 15 s check, so the table changes its line breaks every cycle. It is older than 0.2.0 and cosmetic; a fix needs a look in a browser.
- The kind battery's example shop has NetworkPolicies that keep Prometheus from scraping the cart, frontend and api sidecars, so their own figures are missing there.
- The kind battery waits on a 5-minute rate window, so a local rerun right after a restart can pass on old samples. CI starts fresh clusters.
- Nothing checks that the Terraform example keeps the name restriction of the ConfigMap rule. `src/server/sources/rbac.test.ts` checks the chart's rules and `deploy/reader-access.yaml`, not `examples/terraform/eks-access/main.tf`, which passes the restriction on with `resource_names = try(rule.value.resourceNames, null)`: without that line the role would read every ConfigMap.

## Egress the mesh needs

- A workload that reaches istiod only through an `ipBlock` rule on TCP 15012 gets the istiod line, because netatlas does not count an address rule as reaching istiod. Whether a rule admits a pod's address depends on the enforcer, and this was not checked against an enforcer's source.

## The release

- The release workflow (`.github/workflows/release.yml`) names each action by version tag, for example `docker/login-action@v4.7.0`. The owner of an action can move a tag, and in this workflow the job token may write packages, and in the `github-release` job contents. Naming each action by commit is not done. Whether each named version exists was not checked.
- The `github-release` job is unproven until the `v0.2.0` tag runs it for the first time. If it fails, use Re-run failed jobs: a full re-run stops at the check that the version is not published yet. The `gh` version on the runner was not checked.
