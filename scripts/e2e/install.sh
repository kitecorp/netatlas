#!/usr/bin/env bash
# Builds netatlas and installs it with its chart in atlas-a, reading atlas-a with its own
# ServiceAccount and atlas-b with a reader token. The token and the CA go from one cluster to the
# other through a pipe and are never printed.
set -euo pipefail

cd "$(dirname "$0")/../.."

IMAGE=netatlas:e2e
GENERATED=e2e/.generated

# 1. The reader access a token cluster gets, and its token Secret, which Kubernetes fills in.
kubectl --context kind-atlas-b apply -f deploy/reader-access.yaml
for attempt in $(seq 90); do
  [ -n "$(kubectl --context kind-atlas-b -n netatlas-access get secret netatlas-reader-token -o go-template='{{if .data}}{{if .data.token}}filled{{end}}{{end}}')" ] && break
  if [ "$attempt" -eq 90 ]; then
    echo "install.sh: Kubernetes did not fill the token of netatlas-reader-token in atlas-b within 90 seconds" >&2
    exit 1
  fi
  sleep 1
done

# 2. The same token and CA in atlas-a, as the Secret the chart mounts. The go-template writes the new
# Secret's manifest with the values still base64, straight into kubectl apply.
kubectl --context kind-atlas-a create namespace netatlas --dry-run=client -o yaml | kubectl --context kind-atlas-a apply -f -
kubectl --context kind-atlas-b -n netatlas-access get secret netatlas-reader-token -o go-template='apiVersion: v1
kind: Secret
type: Opaque
metadata:
  name: netatlas-atlas-b
  namespace: netatlas
data:
  token: {{index .data "token"}}
  ca.crt: {{index .data "ca.crt"}}
' | kubectl --context kind-atlas-a apply -f -

# 3. The values, with atlas-b's API server and its Prometheus NodePort at atlas-b's address on the kind
# network, which atlas-a's pods reach.
ATLAS_B_IP=$(docker inspect -f '{{(index .NetworkSettings.Networks "kind").IPAddress}}' atlas-b-control-plane)
mkdir -p "$GENERATED"
sed -e "s|ATLAS_B_SERVER|https://$ATLAS_B_IP:6443|" -e "s|ATLAS_B_IP|$ATLAS_B_IP|g" e2e/values.template.yaml > "$GENERATED/values.yaml"

# 4. The image, loaded into atlas-a, and the chart. The build annotation rolls the pod on every
# install, so a rebuilt image with the same tag is the one that runs.
docker build --tag "$IMAGE" .
kind load docker-image "$IMAGE" --name atlas-a
helm upgrade --install netatlas charts/netatlas --kube-context kind-atlas-a --namespace netatlas \
  --values "$GENERATED/values.yaml" \
  --set image.repository=netatlas --set image.tag=e2e --set image.pullPolicy=Never \
  --set-string podAnnotations.build="$(date -u +%Y%m%dT%H%M%SZ)" \
  --wait --timeout 300s
