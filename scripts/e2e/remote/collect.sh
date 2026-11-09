#!/usr/bin/env bash
# Runs ON the e2e VM as root (ssh ... 'sudo bash -s' < collect.sh > vm.tgz).
# Writes a gzipped tar to stdout: platformctl logs and timings, cloud-init
# output, and a cluster dump (pods, events, describe of unhealthy pods, every
# container's logs). The runner redacts it before upload; /etc/platform is
# never collected.
set -uo pipefail
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
mkdir -p "$out/platformctl" "$out/cluster/logs" "$out/host"

cp -a /var/log/platformctl/. "$out/platformctl/" 2>/dev/null
cp /var/log/cloud-init-output.log "$out/host/" 2>/dev/null
{ uptime; echo; free -m; echo; df -h; } > "$out/host/resources.txt" 2>&1
journalctl -u k3s --no-pager -n 3000 > "$out/host/k3s-journal.log" 2>&1

if command -v kubectl >/dev/null && [ -r "$KUBECONFIG" ]; then
  k() { timeout 60 kubectl "$@"; }
  k get nodes -o wide > "$out/cluster/nodes.txt" 2>&1
  k describe nodes > "$out/cluster/nodes-describe.txt" 2>&1
  k get pods -A -o wide > "$out/cluster/pods.txt" 2>&1
  k get events -A --sort-by=.lastTimestamp > "$out/cluster/events.txt" 2>&1
  k get deploy,sts,ds,jobs,ingress,certificates.cert-manager.io -A -o wide > "$out/cluster/workloads.txt" 2>&1
  k get applications.argoproj.io -A -o wide > "$out/cluster/argocd-apps.txt" 2>&1
  helm list -A > "$out/cluster/helm-releases.txt" 2>&1 || true
  k get pods -A --no-headers 2>/dev/null | awk '$4 != "Running" && $4 != "Completed" {print $1, $2}' |
    while read -r ns pod; do k -n "$ns" describe pod "$pod"; echo "----"; done > "$out/cluster/unhealthy-pods-describe.txt" 2>&1
  k get pods -A -o jsonpath='{range .items[*]}{.metadata.namespace} {.metadata.name} {range .spec.containers[*]}{.name},{end}{"\n"}{end}' 2>/dev/null |
    while read -r ns pod containers; do
      for c in ${containers//,/ }; do
        f="$out/cluster/logs/${ns}_${pod}_${c}.log"
        k -n "$ns" logs "$pod" -c "$c" --tail=3000 > "$f" 2>&1
        k -n "$ns" logs "$pod" -c "$c" --previous --tail=1000 > "$f.previous" 2>/dev/null || rm -f "$f.previous"
      done
    done
fi
tar -C "$out" -czf - .
