#!/usr/bin/env bash
# Starts the two kind clusters the kind journeys read and puts the example shop in both: atlas-a,
# where netatlas runs, and atlas-b, with Istio, Istio's sample Prometheus and a load generator that
# calls a server in its namespace, the shop's recommender and fortio's servers in a container outside
# both clusters. Safe to rerun: an existing cluster is kept, a stopped atlas-b (the unreachable journey
# stops it) and a stopped outside container are started again, and the shop's objects are applied
# again, which restores a policy an Apply journey changed.
set -euo pipefail

cd "$(dirname "$0")/../.."

# kind v0.33.0's node image, pinned by digest so a rerun gets the same Kubernetes.
NODE_IMAGE='kindest/node:v1.37.0@sha256:a1ed56cfb0e7b93589bdf97c8cd566405a265939e3620fc4f5de89adff580ae5'
ISTIO_VERSION=1.32.0
ISTIO_CHARTS=https://blob.istio.io/istio-release/charts
# Istio's sample Prometheus at a fixed commit of the 1.32 line, so a rerun gets the same objects.
PROMETHEUS=https://raw.githubusercontent.com/istio/istio/19cc19624069db78ce5c6940b7be94c540eecfb0/samples/addons/prometheus.yaml
# fortio, for the servers outside the clusters, the shop's recommender and the traffic namespace: the one
# place its image is written, which the manifests' FORTIO_IMAGE stands for.
FORTIO_IMAGE='fortio/fortio:1.76.0@sha256:3dd31ddeb4f962a1dae8cc2a0bce62c408ac830c8435bbea51b1e0fd4c8f7181'
MANIFESTS=e2e/manifests
GENERATED=e2e/.generated
APPLY=(apply --server-side --force-conflicts --field-manager netatlas-e2e)

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

# The Prometheus that scrapes the sidecars every 15 s, and the NodePort netatlas reaches it through.
kubectl --context kind-atlas-b "${APPLY[@]}" -f "$PROMETHEUS" -f "$MANIFESTS/prometheus-nodeport.yaml"
kubectl --context kind-atlas-b rollout status deployment/prometheus -n istio-system --timeout=300s

# fortio's servers outside both clusters, HTTP on 8080 and TCP echo on 8078, on the kind network that
# kind created with the first cluster. The load generator's manifest takes the container's address,
# which can change when the container starts again, so the manifests are written on every run.
if docker container inspect netatlas-outside >/dev/null 2>&1; then
  docker start netatlas-outside >/dev/null
else
  docker run -d --name netatlas-outside --network kind "$FORTIO_IMAGE" server >/dev/null
fi
OUTSIDE_IP=$(docker inspect -f '{{(index .NetworkSettings.Networks "kind").IPAddress}}' netatlas-outside)
mkdir -p "$GENERATED"
sed "s|FORTIO_IMAGE|$FORTIO_IMAGE|g" "$MANIFESTS/workloads.template.yaml" > "$GENERATED/workloads.yaml"
sed -e "s|FORTIO_IMAGE|$FORTIO_IMAGE|g" -e "s/OUTSIDE_IP/$OUTSIDE_IP/g" "$MANIFESTS/traffic.template.yaml" > "$GENERATED/traffic.yaml"

# The shop's NetworkPolicies let each workload call only the next one and kube-dns, as the example
# defines them, so they leave out istiod: a sidecar that starts under them never gets its first
# configuration, and its pod stays in Init (measured). So they are applied only once every pod is
# ready, and a rerun removes them first, because a restarted node restarts its pods too. Applying
# them again also restores a policy an Apply journey changed.
for cluster in atlas-a atlas-b; do
  context="kind-$cluster"
  apply=(kubectl --context "$context" "${APPLY[@]}")
  "${apply[@]}" -f "$MANIFESTS/namespaces.yaml"
  if [ "$cluster" = atlas-b ]; then
    kubectl --context "$context" label namespace shop payments istio-injection=enabled --overwrite
  fi
  kubectl --context "$context" delete -f "$MANIFESTS/network-policies.yaml" --ignore-not-found
  "${apply[@]}" -f "$GENERATED/workloads.yaml"
  if [ "$cluster" = atlas-b ]; then
    # istiod validates AuthorizationPolicies. On a node that was just started again, the Deployment can
    # still say it is available before istiod answers, so the apply is tried until istiod takes it.
    for attempt in $(seq 60); do
      "${apply[@]}" -f "$MANIFESTS/istio-policies.yaml" && break
      [ "$attempt" -lt 60 ] || exit 1
      sleep 5
    done
    # Its ServiceEntry goes through the same validation, which istiod now answers.
    "${apply[@]}" -f "$GENERATED/traffic.yaml"
    namespaces=(ingress shop payments traffic)
    policies=(-f "$MANIFESTS/network-policies.yaml" -f "$MANIFESTS/traffic-policies.yaml")
  else
    "${apply[@]}" -f "$MANIFESTS/apply-access.yaml"
    namespaces=(ingress shop payments)
    policies=(-f "$MANIFESTS/network-policies.yaml")
  fi
  # Only the shop's namespaces, and atlas-b's traffic: netatlas's own Deployment in atlas-a may be the
  # one that is broken, and waiting for it here would stop the script with the shop's policies deleted.
  # Istio's helm --wait already waited for istiod, and the rollout above for Prometheus.
  for ns in "${namespaces[@]}"; do
    kubectl --context "$context" wait deployment --all --namespace "$ns" --for=condition=Available --timeout=300s
  done
  "${apply[@]}" "${policies[@]}"
done
