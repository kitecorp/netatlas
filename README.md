# netatlas

netatlas shows the NetworkPolicies and Istio AuthorizationPolicies of every Kubernetes cluster you run from one place. It edits a NetworkPolicy as a draft in your browser, which ends in Copy YAML for git or in Apply with your own token.

## What 0.1.0 does

- **Overview**: a row per cluster with its Kubernetes version, workloads, policies, workloads no policy selects, the enforcer it found and its Istio mode, and a list of what needs attention.
- **Policy map**: one cluster's workloads by namespace, the Internet as one node, and a line for each call a NetworkPolicy or an Istio AuthorizationPolicy allows. A workload no policy selects is marked open.
- **Policies**: every policy, grouped by cluster, and the editor for one NetworkPolicy, with a line difference before anything is saved. Istio policies are shown, not edited.

netatlas reads seven kinds: namespaces, pods, ReplicaSets, Jobs, DaemonSets, NetworkPolicies and AuthorizationPolicies. It never reads Secrets, and it stores no token: Apply uses the token you paste for that one request.

0.2.0 adds traffic between workloads and the domains and IPs outside the cluster that they call.

## Quick start

Install it in a cluster and let it read that cluster with its own ServiceAccount. Write `values.yaml`:

```yaml
clusters:
  - name: my-cluster
    login:
      type: inCluster
```

Then install the chart and open netatlas on http://localhost:3000:

```sh
helm install netatlas oci://ghcr.io/kitecorp/charts/netatlas --version 0.1.0 --namespace netatlas --create-namespace -f values.yaml
kubectl -n netatlas port-forward svc/netatlas 3000:80
```

## Documentation

- [Install](docs/install.md): the chart, its values, port-forward, health and the ingress.
- [Clusters](docs/clusters.md): the `clusters` value, and reading a cluster with a token.
- [EKS](docs/eks.md): reading EKS clusters with the pod's AWS role.
- [Editing and Apply](docs/editing.md): the editor, Copy YAML and Apply with your token.
- [What 0.1.0 leaves out](docs/todo.md)

## Development

netatlas is a Next.js app in TypeScript. With Node 26.13.1 or later:

```sh
npm ci
npx playwright install chromium
npm run typecheck
npm run lint
npm test
npm run build
npm run test:package
npm run e2e:standalone
```

`npm run e2e:standalone` runs the built server, so it comes after `npm run build`. Both browser runs need the Chromium that `npx playwright install chromium` downloads.

The kind battery starts two kind clusters with an example shop, installs netatlas in one of them with its chart, and runs the browser journeys against both. It needs docker, kind, helm, kubectl and Playwright's Chromium:

```sh
bash scripts/e2e/up.sh
bash scripts/e2e/install.sh
npm run e2e:kind
bash scripts/e2e/down.sh
```

The documentation site is built from this README and the pages under `docs/`, with Hugo in docker, then checked:

```sh
scripts/build-site.sh <empty folder>
scripts/check-site.sh <that folder>
```

## Made by

netatlas is made by the team behind [Transferify](https://transferify.eu) ([transferify.ro](https://transferify.ro) in Romania).

## Licence

Apache-2.0. See [LICENSE](LICENSE).
