package k3s

import (
	"fmt"
	"strings"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/shell"
)

// MaxCoreDNSReplicas caps cluster DNS replicas: one per server of a 3-server
// control plane is enough, more only adds load.
const MaxCoreDNSReplicas = 3

// CoreDNSReplicas is the CoreDNS replica count for a cluster with readyNodes
// Ready nodes: one per node up to MaxCoreDNSReplicas, never below 1.
func CoreDNSReplicas(readyNodes int) int {
	if readyNodes < 1 {
		return 1
	}
	if readyNodes > MaxCoreDNSReplicas {
		return MaxCoreDNSReplicas
	}
	return readyNodes
}

// coreDNSScaleScript waits for node (this server) to be Ready, then raises the
// CoreDNS replicas to CoreDNSReplicas(<Ready nodes>). It never scales down, so
// an operator's larger count and a temporarily NotReady server are left alone.
// k3s ships CoreDNS with one replica and a hostname topology spread
// (DoNotSchedule) and its manifest sets no replica count, so the count
// survives k3s restarts and each added replica lands on a node without one.
// Scaling after this node is Ready is what places the new replica here.
func coreDNSScaleScript(node string) string {
	return fmt.Sprintf(`set -uo pipefail
export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
node=%s
for _ in $(seq 1 90); do
  [[ "$(kubectl get node "$node" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null)" == "True" ]] && break
  sleep 2
done
ready="$(kubectl get nodes --no-headers 2>/dev/null | awk '$2 ~ /^Ready/' | wc -l)"
cur="$(kubectl -n kube-system get deploy coredns -o jsonpath='{.spec.replicas}')" || exit 1
want=$(( ready < 1 ? 1 : (ready > %d ? %d : ready) ))
if (( cur >= want )); then echo "CoreDNS replicas: $cur"; exit 0; fi
kubectl -n kube-system scale deploy coredns --replicas="$want" >/dev/null && echo "CoreDNS replicas: $cur -> $want"
`, shellQuote(node), MaxCoreDNSReplicas, MaxCoreDNSReplicas)
}

// EnsureCoreDNSReplicas spreads cluster DNS over the servers (ha profile,
// #54). With the k3s default of one replica, powering off the node that ran
// it broke every in-cluster name lookup (the API could not resolve its
// database) until the pod was rescheduled (5 minutes on the failover test).
// node is this server's Kubernetes node name.
func EnsureCoreDNSReplicas(node string) error {
	node = strings.TrimSpace(node)
	if node == "" {
		return fmt.Errorf("empty node name")
	}
	out, err := shell.OutputBash(coreDNSScaleScript(node))
	if err != nil {
		return fmt.Errorf("scale CoreDNS: %w", err)
	}
	if s := strings.TrimSpace(out); s != "" {
		fmt.Println("  " + s)
	}
	return nil
}
