#!/usr/bin/env bash
# Stops a release whose image is already published, so a tag pushed again never replaces what people
# pinned. It fails closed: only the registry's clear "not found" lets the release go on, and any other
# error (an outage, a rate limit, a login that failed) stops it. buildx reports a missing manifest as
# "<ref>: not found" (seen against docker.io and ghcr.io); the registry API's codes are kept as well.
set -euo pipefail

image=$1
if out=$(docker buildx imagetools inspect "$image" 2>&1); then
  echo "::error::$image is already published"
  exit 1
fi
case "$out" in
  *": not found"* | *MANIFEST_UNKNOWN* | *NAME_UNKNOWN*)
    echo "$image is not published yet"
    ;;
  *)
    echo "::error::cannot tell whether $image is published: ${out//$'\n'/ }"
    exit 1
    ;;
esac
