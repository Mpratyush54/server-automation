#!/usr/bin/env bash
# Decide what the e2e workflow tests. Pure logic (no network); unit-tested by
# scripts/tests/e2e-plan.test.mjs.
#
# Input (environment): EVENT_NAME, REF_TYPE, REF_NAME, IN_PROFILE, IN_VERSION,
# IN_IMAGE_TAG, IN_STACK, ROLE_ARN, REGION.
# Output: key=value lines appended to $GITHUB_OUTPUT (stdout when unset).
#
#   enabled     true when the AWS role and region repository variables are set
#   profiles    JSON array for the job matrix
#   mode        release (test a published release binary) | build (build from the commit)
#   release_tag vX.Y.Z[-pre] in release mode
#   image_tag   platform-api / platform-portal image tag
#   image_note  human-readable note when the images are not the commit's own
#   stack       PLATFORM_STACK channel or version
#   promote     true when a passing run must promote the release to stable/latest
set -euo pipefail

EVENT_NAME="${EVENT_NAME:-workflow_dispatch}"
REF_TYPE="${REF_TYPE:-branch}"
REF_NAME="${REF_NAME:-}"
IN_PROFILE="${IN_PROFILE:-}"
IN_VERSION="${IN_VERSION:-}"
IN_IMAGE_TAG="${IN_IMAGE_TAG:-}"
IN_STACK="${IN_STACK:-}"

fail() { echo "plan: $*" >&2; exit 1; }
semver='^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
stable='^v[0-9]+\.[0-9]+\.[0-9]+$'

enabled=false
if [[ -n "${ROLE_ARN:-}" && -n "${REGION:-}" ]]; then enabled=true; fi

case "$EVENT_NAME" in
  schedule|push) profiles='["minimal","full"]' ;;
  workflow_dispatch)
    case "${IN_PROFILE:-minimal}" in
      minimal|"") profiles='["minimal"]' ;;
      full) profiles='["full"]' ;;
      both) profiles='["minimal","full"]' ;;
      *) fail "profile must be minimal, full or both" ;;
    esac ;;
  *) fail "unsupported event $EVENT_NAME" ;;
esac

mode=build
release_tag=""
if [[ -n "$IN_VERSION" ]]; then
  [[ "$IN_VERSION" == v* ]] || IN_VERSION="v$IN_VERSION"
  [[ "$IN_VERSION" =~ $semver ]] || fail "platformctl_version must look like v1.2.3 or v1.2.3-rc.1"
  mode=release
  release_tag="$IN_VERSION"
elif [[ "$REF_TYPE" == tag && "$REF_NAME" =~ $semver ]]; then
  mode=release
  release_tag="$REF_NAME"
fi

image_note=""
if [[ -n "$IN_IMAGE_TAG" ]]; then
  [[ "$IN_IMAGE_TAG" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || fail "invalid image tag"
  image_tag="$IN_IMAGE_TAG"
  image_note="image tag set by the workflow_dispatch input"
elif [[ "$mode" == release ]]; then
  image_tag="${release_tag#v}"
elif [[ "$REF_TYPE" == branch && "$REF_NAME" == master ]]; then
  image_tag=master
else
  image_tag=master
  image_note="no platform images are published for ${REF_TYPE} ${REF_NAME:-?}; using the latest master images"
fi

if [[ -n "$IN_STACK" ]]; then
  [[ "$IN_STACK" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$ ]] || fail "invalid stack"
  stack="$IN_STACK"
elif [[ "$mode" == release ]]; then
  stack=stable
else
  stack=edge
fi

# Promote only a stable tag, tested with its own release binary on both profiles.
promote=false
if [[ "$REF_TYPE" == tag && "$mode" == release && "$release_tag" == "$REF_NAME" \
      && "$REF_NAME" =~ $stable && "$profiles" == '["minimal","full"]' && -z "$IN_IMAGE_TAG" \
      && ( "$EVENT_NAME" == push || "$EVENT_NAME" == workflow_dispatch ) ]]; then
  promote=true
fi

emit() {
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then cat >> "$GITHUB_OUTPUT"; else cat; fi
}
{
  echo "enabled=$enabled"
  echo "profiles=$profiles"
  echo "mode=$mode"
  echo "release_tag=$release_tag"
  echo "image_tag=$image_tag"
  echo "image_note=$image_note"
  echo "stack=$stack"
  echo "promote=$promote"
} | emit
