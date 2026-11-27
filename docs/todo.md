# What 0.1.0 leaves out

netatlas 0.1.0 shows the network policies of your clusters and edits NetworkPolicies; this page lists what it does not do yet.

- Traffic, and the domains and IPs outside the cluster that workloads call (0.2.0), findings (0.3.0) and the agent (0.4.0).
- Creating and deleting policies, and editing Istio policies.
- The Calico, Cilium and AdminNetworkPolicy kinds.
- kindnet as an enforcer.
- Services.
- The EKS smoke run outside CI.
- Warn when an egress NetworkPolicy blocks meshed pods from reaching istiod: their sidecars cannot start, so the pods stay in Init.
