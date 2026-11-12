#!/usr/bin/env bash
# Regenerates platformctl/internal/images/images.txt: every container image the
# installer's pinned Helm charts (platformctl/internal/versions) and static
# manifests reference. platformctl embeds the list and pre-pulls it in parallel
# right after k3s is ready.
#
# Usage:
#   scripts/gen-images.sh           # rewrite images.txt
#   scripts/gen-images.sh --check   # exit 1 if images.txt is stale
#
# Requires: go, helm 3 (override with HELM=/path/to/helm), and jq or python3.
# platform-api / platform-portal / platform-profile-ingest are NOT listed: their tag is chosen at install
# time, so platformctl passes them to images.PrePull as extras.
set -euo pipefail
[ -n "${GEN_IMAGES_DEBUG:-}" ] && set -x

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PCTL="$ROOT/platformctl"
DATA="$PCTL/internal/manifests/data"
OUT="$PCTL/internal/images/images.txt"
HELM="${HELM:-helm}"
DOMAIN="example.com"
# MSYS bash on Windows: stop it rewriting oci:// refs passed to helm.exe.
export MSYS2_ARG_CONV_EXCL="${MSYS2_ARG_CONV_EXCL:-oci://}"

CHECK=0
case "${1:-}" in
  --check) CHECK=1 ;;
  "") ;;
  *) echo "usage: $0 [--check]" >&2; exit 2 ;;
esac

command -v "$HELM" >/dev/null 2>&1 || { echo "gen-images: helm not found (set HELM=...)" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

(cd "$PCTL" && go run . charts --json) | tr -d '\r' > "$WORK/charts.json"

# Emit one "name|repoUrl|chart|version" line per chart, then "k3s|<ver>".
# ("|" rather than tabs: `read` collapses empty whitespace-separated fields.)
parse_charts() {
  if command -v jq >/dev/null 2>&1; then
    jq -r '.charts[] | [.name, (.repoUrl // ""), .chart, .version] | join("|")' "$1"
    jq -r '"k3s|" + .k3s' "$1"
  else
    python3 -I -c '
import json, sys
d = json.load(open(sys.argv[1]))
for c in d["charts"]:
    print("|".join([c["name"], c.get("repoUrl", ""), c["chart"], c["version"]]))
print("k3s|" + d["k3s"])
' "$1"
  fi
}

parse_charts "$WORK/charts.json" | tr -d '\r' > "$WORK/charts.lst"
if command -v jq >/dev/null 2>&1; then
  CHART_MIRROR="$(jq -r '.chartMirror' "$WORK/charts.json")"
else
  CHART_MIRROR="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["chartMirror"])' "$WORK/charts.json")"
fi
K3S="$(awk -F'|' '$1=="k3s"{print $2}' "$WORK/charts.lst")"
KUBE_VERSION="${K3S%%+*}" # v1.37.2+k3s1 -> v1.37.2

# values <file>: copy a repo values file with installer placeholders filled in.
values() {
  local src="$DATA/$1" dst="$WORK/$1"
  sed -e "s/{{DOMAIN}}/$DOMAIN/g" -e "s|{{OIDC_INTERNAL}}|http://platform-api.platform.svc.cluster.local:3000/api/oauth|g" -e "s/{{[A-Z0-9_]*}}/placeholder/g" -e 's/REPLACE_COOKIE_SECRET/0123456789abcdef/g' "$src" > "$dst"
  sed -i 's/RETENTION_HOURS/720h/g;s/SAMPLING_PERCENTAGE/100/g' "$dst"
  printf '%s' "$dst"
}

# chart_args <name>: the same values files and image-affecting --set flags as
# platformctl/internal/components/components.go. Keep these in sync.
chart_args() {
  case "$1" in
    ingress-nginx)
      echo "--set controller.service.type=LoadBalancer --set controller.allowSnippetAnnotations=true" ;;
    cert-manager)
      echo "--set installCRDs=true" ;;
    postgresql)
      echo "--set auth.postgresPassword=x --set auth.database=platform --set metrics.enabled=true" ;;
    mongodb)
      echo "--set auth.rootPassword=x --set metrics.enabled=true" ;;
    redis)
      echo "--set auth.password=x --set metrics.enabled=true" ;;
    minio)
      echo "-f $(values minio-values.yaml) --set auth.rootUser=x --set auth.rootPassword=xxxxxxxx" \
           "--set image.repository=bitnamilegacy/minio" \
           "--set console.image.repository=bitnamilegacy/minio-object-browser" ;;
    argo-cd)
      echo "-f $(values argocd-values.yaml) --set crds.install=false --set applicationSet.enabled=false" \
           "--set notifications.enabled=false --set dex.enabled=false" ;;
    argocd-image-updater)
      echo "--set config.registries[0].name=ghcr --set config.registries[0].api_url=https://ghcr.io" \
           "--set config.registries[0].prefix=ghcr.io" ;;
    kube-prometheus-stack)
      echo "-f $(values grafana-values.yaml) --set grafana.adminPassword=x --set grafana.assertNoLeakedSecrets=false" ;;
    alloy|tempo|loki|pyroscope|prometheus-blackbox-exporter)
      echo "-f $(values telemetry-$1-values.yaml)" ;;
    loki-stack)
      echo "--set grafana.enabled=false --set prometheus.enabled=false" ;;
    oauth2-proxy)
      echo "-f $(values oauth2-proxy-values.yaml)" ;;
    portainer)
      echo "-f $(values portainer-values.yaml) --set service.type=ClusterIP --set ingress.enabled=false" \
           "--set adminPassword.existingSecret=portainer-admin-password" ;;
    longhorn)
      # Match platformctl/internal/components/longhorn.go.
      echo "-f $(values longhorn-values.yaml)" ;;
    kyverno)
      # Match platformctl/internal/components/kyverno.go resource pins.
      echo "--set admissionController.replicas=1" \
           "--set webhooksCleanup.image.repository=bitnamilegacy/kubectl" \
           "--set policyReportsCleanup.image.repository=bitnamilegacy/kubectl" \
           "--set admissionController.container.resources.requests.cpu=100m" \
           "--set admissionController.container.resources.requests.memory=256Mi" \
           "--set admissionController.container.resources.limits.cpu=500m" \
           "--set admissionController.container.resources.limits.memory=512Mi" ;;
    *) echo "" ;;
  esac
}

# extract_images: read rendered YAML on stdin, print image refs.
#  - every `image: <ref>` scalar (quoted or not, optionally a list item)
#  - prometheus-operator's --prometheus-config-reloader=<ref> argument
#  - quoted Longhorn image arguments and driver-deployer environment values
extract_images() {
  tr -d '\r' | sed -n \
    -e 's/^[[:space:]-]*\(value:[[:space:]]*\)\{0,1\}"\(longhornio\/[^"[:space:]]\{1,\}\)"[[:space:]]*$/\2/p' \
    -e 's/^[[:space:]-]*image:[[:space:]]*["'\'']\{0,1\}\([^"'\''[:space:]#]\{1,\}\)["'\'']\{0,1\}[[:space:]]*\(#.*\)\{0,1\}$/\1/p' \
    -e 's/.*--prometheus-config-reloader=["'\'']\{0,1\}\([^"'\''[:space:]]\{1,\}\).*/\1/p' |
    grep -v -e '^{' -e '^\$' -e '^null$' || true
}

set -f # chart_args contains [0]: no globbing
: > "$WORK/images.raw"
# MinIO IAM bootstrap Job is generated by telemetry.go, not by a Helm chart.
while IFS='|' read -r name repo_url chart version; do
  [ "$name" = "k3s" ] && continue
  if [ -n "$repo_url" ]; then
    src=(--repo "$repo_url" "$chart")
  else
    src=("$chart")
  fi
  # --skip-tests: `helm test` pods never run during install.
  # shellcheck disable=SC2046 # chart_args output is intentionally word-split
  render() {
    "$HELM" template "$name" "$@" --version "$version" \
      --namespace "$name" --kube-version "$KUBE_VERSION" --skip-tests \
      $(chart_args "$name") > "$WORK/$name.yaml" 2> "$WORK/$name.err"
  }
  if ! render "${src[@]}"; then
    # Upstream unavailable (e.g. a GitHub Releases outage): use the GHCR mirror.
    echo "gen-images: $name: upstream failed, trying $CHART_MIRROR" >&2
    cat "$WORK/$name.err" >&2
    if ! render "$CHART_MIRROR/${chart##*/}"; then
      echo "gen-images: helm template $name failed (upstream and mirror):" >&2
      cat "$WORK/$name.err" >&2
      exit 1
    fi
  fi
  n_before=$(wc -l < "$WORK/images.raw")
  extract_images < "$WORK/$name.yaml" >> "$WORK/images.raw"
  n_after=$(wc -l < "$WORK/images.raw")
  echo "gen-images: $name $version: $((n_after - n_before)) image refs" >&2
done < "$WORK/charts.lst"

# Images rendered by platformctl itself (not a Helm chart), e.g. kube-vip.
if command -v jq >/dev/null 2>&1; then
  jq -r '.staticImages[]?' "$WORK/charts.json" | tr -d '\r' >> "$WORK/images.raw"
else
  python3 -I -c '
import json, sys
d = json.load(open(sys.argv[1]))
for img in d.get("staticImages") or []:
    print(img)
' "$WORK/charts.json" | tr -d '\r' >> "$WORK/images.raw"
fi

{
  echo "# GENERATED by scripts/gen-images.sh — DO NOT EDIT."
  echo "# Regenerate after bumping platformctl/internal/versions/versions.go or"
  echo "# changing platformctl/internal/manifests/data/*: scripts/gen-images.sh"
  echo "# platform-api / platform-portal / platform-profile-ingest are passed at runtime (tag-dependent)."
  LC_ALL=C sort -u "$WORK/images.raw"
} > "$WORK/images.txt"

if [ "$CHECK" = 1 ]; then
  if ! diff -u "$OUT" "$WORK/images.txt"; then
    echo "gen-images: $OUT is stale; run scripts/gen-images.sh and commit the result" >&2
    exit 1
  fi
  echo "gen-images: images.txt is up to date" >&2
  exit 0
fi

mkdir -p "$(dirname "$OUT")"
cp "$WORK/images.txt" "$OUT"
echo "gen-images: wrote $(grep -vc '^#' "$OUT") images to $OUT" >&2
