#!/usr/bin/env bash
set -euo pipefail

: "${ARGOCD_BASE_URL:?}"
: "${ARGOCD_TOKEN:?}"
: "${ARGOCD_APPLICATION:?}"
: "${EXPECTED_IMAGE:?}"
: "${EXPECTED_DIGEST:?}"

encode() {
  jq -nr --arg value "$1" '$value | @uri'
}

TREE=$(curl -fsS "$ARGOCD_BASE_URL/api/v1/applications/$ARGOCD_APPLICATION/resource-tree" \
  -H "Authorization: Bearer $ARGOCD_TOKEN" -H "Accept: application/json")
PODS=$(jq -r \
  '.nodes[]? | select(.kind == "Pod") | [.namespace, .name, (.group // ""), (.version // "v1")] | join("|")' \
  <<< "$TREE")
if [ -z "$PODS" ]; then
  echo "No Pods found for ArgoCD application $ARGOCD_APPLICATION" >&2
  exit 1
fi

MATCHED_CONTAINERS=0
while IFS='|' read -r NAMESPACE NAME GROUP VERSION; do
  RESOURCE=$(curl -fsS \
    "$ARGOCD_BASE_URL/api/v1/applications/$ARGOCD_APPLICATION/resource?namespace=$(encode "$NAMESPACE")&resourceName=$(encode "$NAME")&version=$(encode "$VERSION")&group=$(encode "$GROUP")&kind=Pod" \
    -H "Authorization: Bearer $ARGOCD_TOKEN" -H "Accept: application/json")
  POD=$(jq -er '.manifest | fromjson' <<< "$RESOURCE")
  CONTAINERS=$(jq -r --arg image "$EXPECTED_IMAGE" \
    '.spec.containers[]? | select(.image == $image or (.image | endswith("/" + $image))) | .name' \
    <<< "$POD")
  [ -n "$CONTAINERS" ] || continue

  while IFS= read -r CONTAINER; do
    IMAGE_ID=$(jq -er --arg name "$CONTAINER" \
      '.status.containerStatuses[] | select(.name == $name and .ready == true) | .imageID' \
      <<< "$POD")
    RUNTIME_DIGEST=$(grep -Eo 'sha256:[0-9a-f]{64}$' <<< "$IMAGE_ID")
    if [ "$RUNTIME_DIGEST" != "$EXPECTED_DIGEST" ]; then
      echo "$ARGOCD_APPLICATION Pod $NAME container $CONTAINER runs $RUNTIME_DIGEST, expected $EXPECTED_DIGEST" >&2
      exit 1
    fi
    MATCHED_CONTAINERS=$((MATCHED_CONTAINERS + 1))
  done <<< "$CONTAINERS"
done <<< "$PODS"

if [ "$MATCHED_CONTAINERS" -eq 0 ]; then
  echo "No ready containers using $EXPECTED_IMAGE found for $ARGOCD_APPLICATION" >&2
  exit 1
fi

echo "$EXPECTED_DIGEST"
