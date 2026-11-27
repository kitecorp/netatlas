#!/usr/bin/env bash
# Starts the two kind clusters the kind journeys read and puts the example shop in both: atlas-a,
# where netatlas runs, and atlas-b, with Istio. Safe to rerun: an existing cluster is kept, a stopped
# atlas-b (the unreachable journey stops it) is started again, and the shop's objects are applied
# again, which restores a policy an Apply journey changed.
set -euo pipefail

cd "$(dirname "$0")/../.."

# kind v0.33.0's node image, pinned by digest so a rerun gets the same Kubernetes.
NODE_IMAGE='kindest/node:v1.37.0@sha256:a1ed56cfb0e7b93589bdf97c8cd566405a265939e3620fc4f5de89adff580ae5'
ISTIO_VERSION=1.32.0
ISTIO_CHARTS=https://blob.istio.io/istio-release/charts
MANIFESTS=e2e/manifests

for cluster in atlas-a atlas-b; do
  if ! kind get clusters | grep -qx "$cluster"; then
    kind create cluster --name "$cluster" --image "$NODE_IMAGE" --wait 120s
  elif [ "$(docker inspect -f '{{.State.Running}}' "$cluster-control-plane")" != true ]; then
    docker start "$cluster-control-plane"
  fi
done

# A restarted node answers again only once its API server is up; three minutes is long past that.
for cluster in atlas-a atlas-b; do
  for attempt in $(seq 90); do
    kubectl --context "kind-$cluster" get --raw /readyz >/dev/null 2>&1 && break
    if [ "$attempt" -eq 90 ]; then
      echo "up.sh: the API server of $cluster did not answer /readyz within 3 minutes" >&2
      exit 1
    fi
    sleep 2
  done
done

# Istio first, so the shop's pods start after the injection label and get their sidecars. Low
# requests let both clusters fit on a CI runner.
kubectl --context kind-atlas-b create namespace istio-system --dry-run=client -o yaml | kubectl --context kind-atlas-b apply -f -
helm upgrade --install istio-base base --kube-context kind-atlas-b --namespace istio-system \
  --repo "$ISTIO_CHARTS" --version "$ISTIO_VERSION" --set defaultRevision=default --wait
helm upgrade --install istiod istiod --kube-context kind-atlas-b --namespace istio-system \
  --repo "$ISTIO_CHARTS" --version "$ISTIO_VERSION" \
  --set autoscaleEnabled=false \
  --set resources.requests.cpu=100m --set resources.requests.memory=256Mi \
  --set global.proxy.resources.requests.cpu=10m --set global.proxy.resources.requests.memory=32Mi \
  --wait

# The shop's NetworkPolicies let each workload call only the next one and kube-dns, as the example
# defines them, so they leave out istiod: a sidecar that starts under them never gets its first
# configuration, and its pod stays in Init (measured). So they are applied only once every pod is
# ready, and a rerun removes them first, because a restarted node restarts its pods too. Applying
# them again also restores a policy an Apply journey changed.
for cluster in atlas-a atlas-b; do
  context="kind-$cluster"
  apply=(kubectl --context "$context" apply --server-side --force-conflicts --field-manager netatlas-e2e)
  "${apply[@]}" -f "$MANIFESTS/namespaces.yaml"
  if [ "$cluster" = atlas-b ]; then
    kubectl --context "$context" label namespace shop payments istio-injection=enabled --overwrite
  fi
  kubectl --context "$context" delete -f "$MANIFESTS/network-policies.yaml" --ignore-not-found
  "${apply[@]}" -f "$MANIFESTS/workloads.yaml"
  if [ "$cluster" = atlas-b ]; then
    # istiod validates AuthorizationPolicies. On a node that was just started again, the Deployment can
    # still say it is available before istiod answers, so the apply is tried until istiod takes it.
    for attempt in $(seq 60); do
      "${apply[@]}" -f "$MANIFESTS/istio-policies.yaml" && break
      [ "$attempt" -lt 60 ] || exit 1
      sleep 5
    done
  else
    "${apply[@]}" -f "$MANIFESTS/apply-access.yaml"
  fi
  # Only the shop's namespaces: netatlas's own Deployment in atlas-a may be the one that is broken, and
  # waiting for it here would stop the script with the shop's policies deleted. Istio's helm --wait
  # already waited for istiod.
  for ns in ingress shop payments; do
    kubectl --context "$context" wait deployment --all --namespace "$ns" --for=condition=Available --timeout=300s
  done
  "${apply[@]}" -f "$MANIFESTS/network-policies.yaml"
done
