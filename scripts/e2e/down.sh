#!/usr/bin/env bash
# Deletes the two kind clusters of the kind journeys and the values install.sh wrote.
set -euo pipefail

cd "$(dirname "$0")/../.."

for cluster in atlas-a atlas-b; do
  kind delete cluster --name "$cluster"
done
rm -rf e2e/.generated
