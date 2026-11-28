#!/usr/bin/env bash
# Deletes the two kind clusters of the kind journeys, the container of the servers outside them, and
# the files up.sh and install.sh wrote.
set -euo pipefail

cd "$(dirname "$0")/../.."

for cluster in atlas-a atlas-b; do
  kind delete cluster --name "$cluster"
done
docker rm -f netatlas-outside
rm -rf e2e/.generated
