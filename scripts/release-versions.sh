#!/usr/bin/env bash
# Checks that every place naming the version a release publishes names the same one: package.json, the chart's
# version and appVersion, each image of its artifacthub.io/images annotation, which must be the one the release pushes,
# and the tag in each address of its artifacthub.io/screenshots annotation. A release publishes the image and the
# chart under one version, and Artifact Hub does not read a version of the chart again once it has indexed it, so a
# place left behind stays wrong there.
# Given the git tag (v<version>), it compares every place with the tag; without one, with package.json, so CI finds a
# disagreement before anyone pushes a tag. It prints the version when every place agrees, and otherwise one error for
# each value that disagrees, on stderr, where GitHub Actions reads ::error:: lines too.
set -euo pipefail
if (($# > 1)); then
  echo "usage: release-versions.sh [v<major>.<minor>.<patch>, the git tag of the release]" >&2
  exit 2
fi
root=$(cd "$(dirname "$0")/.." && pwd)
chart=$root/charts/netatlas/Chart.yaml
status=0
fail() {
  echo "::error::$*" >&2
  status=1
}

# yq is on GitHub's runners. A value it cannot read stops the check, naming what it could not read, rather than
# reading as no value; yq's own reason, a parse error or a missing yq, follows on the next line.
read_yaml() {
  local what=$1 expression=$2 file=$3 out
  if ! out=$(yq -oy "$expression" "$file" 2>&1); then
    echo "::error::yq could not read $what:" >&2
    echo "$out" >&2
    exit 1
  fi
  printf '%s\n' "$out"
}

package=$(read_yaml package.json '.version' "$root/package.json")
if (($# == 1)); then
  version=${1#v}
  against="the tag is $1"
  [[ $package == "$version" ]] || fail "package.json version is $package where $against"
else
  version=$package
  against="package.json version is $package"
fi

value=$(read_yaml 'Chart.yaml version' '.version' "$chart")
[[ $value == "$version" ]] || fail "Chart.yaml version is $value where $against"
value=$(read_yaml 'Chart.yaml appVersion' '.appVersion' "$chart")
[[ $value == "$version" ]] || fail "Chart.yaml appVersion is $value where $against"

# Each annotation is YAML written inside a string, so it is read twice: the string, then the list in it. yq prints each
# entry after "- ", so an entry with no value is still a line: as a bare empty line at the end of the list, the command
# substitution would drop it, and the entry would pass unchecked.
entries() {
  read_yaml "Chart.yaml $1" "(.annotations[\"$1\"] // \"[]\") | from_yaml | .[] | \"- \" + (.$2 // \"\")" "$chart"
}

# The image the release pushes (release.yml), so an image of another repository disagrees even with the right tag.
pushed=ghcr.io/kitecorp/netatlas:$version
images=$(entries artifacthub.io/images image)
if [[ -z $images ]]; then
  fail "Chart.yaml artifacthub.io/images names no image"
else
  while IFS= read -r entry; do
    image=${entry#- }
    [[ $image == "$pushed" ]] ||
      fail "Chart.yaml artifacthub.io/images names ${image:-an entry with no image} where $against: the release pushes $pushed"
  done <<<"$images"
fi

# Only an address at the release's own tag shows the pictures of that version: another tag shows another version's,
# and a branch moves after the release.
at_tag='^https://raw\.githubusercontent\.com/[^/]+/[^/]+/([^/]+)/'
addresses=$(entries artifacthub.io/screenshots url)
if [[ -z $addresses ]]; then
  fail "Chart.yaml artifacthub.io/screenshots names no address"
else
  while IFS= read -r entry; do
    address=${entry#- }
    [[ $address =~ $at_tag && ${BASH_REMATCH[1]} == "v$version" ]] ||
      fail "Chart.yaml artifacthub.io/screenshots names ${address:-an entry with no url} where $against: each address must be a file at the tag v$version on raw.githubusercontent.com"
  done <<<"$addresses"
fi

((status == 0)) && echo "$version"
exit "$status"
