#!/usr/bin/env bash
# Waits until atlas-b's Prometheus holds the HTTP and the TCP calls of the traffic namespace's client
# (scripts/e2e/up.sh), so the traffic journeys find figures to show. It asks through the API server's
# proxy to the sample's own Service, which needs nothing but the kind context. A rate needs two
# scrapes, and the sample scrapes every 15 s. WAIT_TRAFFIC_LIMIT sets the limit in seconds.
set -euo pipefail

LIMIT=${WAIT_TRAFFIC_LIMIT:-300}
# The limit is compared as a number on every pass; a limit that is no number makes that comparison fail
# each time, and the wait would then never end when no traffic comes.
[[ $LIMIT =~ ^[0-9]+$ ]] || { echo "wait-traffic.sh: WAIT_TRAFFIC_LIMIT must be a whole number of seconds, not '$LIMIT'" >&2; exit 2; }
QUERIES=(
  'rate(istio_requests_total{reporter="source",source_workload="client"}[5m]) > 0'
  'rate(istio_tcp_sent_bytes_total{reporter="source",source_workload="client"}[5m]) > 0'
)

paths=()
for query in "${QUERIES[@]}"; do
  encoded=$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$query")
  paths+=("/api/v1/namespaces/istio-system/services/prometheus:9090/proxy/api/v1/query?query=$encoded")
done

# A query holds once its vector has a series: an empty one, an error or no answer yet does not. kubectl
# sets no timeout of its own, and the API server lets a proxy request run as long as it lasts, so the
# request timeout keeps a Prometheus that never answers from holding the loop past its limit. The last
# answer or error is kept for the message when the limit passes.
last='no answer yet'
holds() {
  last=$(kubectl --context kind-atlas-b get --raw "$1" --request-timeout=10s 2>&1) || return 1
  [[ $last == *'"result":[{'* ]]
}

start=$SECONDS
while true; do
  recorded=true
  for path in "${paths[@]}"; do
    holds "$path" || { recorded=false; break; }
  done
  if $recorded; then
    echo "wait-traffic.sh: traffic recorded after $((SECONDS - start)) s"
    exit 0
  fi
  if [ $((SECONDS - start)) -ge "$LIMIT" ]; then
    echo "wait-traffic.sh: no traffic recorded in $LIMIT s. The last answer: ${last:0:500}" >&2
    exit 1
  fi
  sleep 5
done
