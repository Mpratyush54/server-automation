package components

import (
	"fmt"
	"time"

	"github.com/fatih/color"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/shell"
)

// haFullNodes is the node count the ha datastores are sized for: one MongoDB,
// Redis and PostgreSQL member per node.
const haFullNodes = 3

// partialReadyNodes is replaceable in tests (0 when the nodes cannot be listed).
var partialReadyNodes = func() int {
	n, err := readyNodeCount()
	if err != nil {
		return 0
	}
	return n
}

// haPartialCluster reports an ha install that runs on fewer than three Ready
// nodes: the first server provisioned before the others joined. Waiting for
// every datastore member there only ran into helm's 10-minute timeout: the
// later members' Longhorn volumes do not fit next to the first ones on one
// node (scheduling space) and PostgreSQL standbys need a node each.
func haPartialCluster(cfg *config.Config) (bool, int) {
	if cfg == nil || !cfg.IsHA() {
		return false, 0
	}
	n := partialReadyNodes()
	return n > 0 && n < haFullNodes, n
}

// waitFirstMember waits for the first member of a datastore StatefulSet
// (the primary that serves on its own) instead of all of them. Replaceable in
// tests.
var waitFirstMember = func(pod string, timeout time.Duration) error {
	secs := int(timeout.Seconds())
	return shell.RunBash(fmt.Sprintf(`set -euo pipefail
export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
timeout %[2]ds bash -c 'until kubectl -n databases get pod %[1]s >/dev/null 2>&1; do sleep 3; done
kubectl -n databases wait --for=condition=Ready pod/%[1]s --timeout=%[2]ds'
`, pod, secs))
}

// partialMemberNotice tells the operator why the other members wait.
func partialMemberNotice(label, firstPod string, nodes int) string {
	return fmt.Sprintf("  %s: %s is ready; the other members start when the remaining servers join (%d of %d nodes Ready). Join them with `platformctl join --role server`, then run `sudo platformctl install longhorn` here.", label, firstPod, nodes, haFullNodes)
}

// installHADatastore installs a replicated datastore; on a partial ha cluster
// it waits only for the first member.
func installHADatastore(cfg *config.Config, r helmRelease, firstPod string) error {
	partial, nodes := haPartialCluster(cfg)
	if !partial {
		return r.reconcile("--wait", "--timeout", "10m")
	}
	if err := r.reconcile(); err != nil {
		return err
	}
	if err := waitFirstMember(firstPod, 10*time.Minute); err != nil {
		return fmt.Errorf("%s: %s not ready: %w", r.Label, firstPod, err)
	}
	color.Yellow(partialMemberNotice(r.Label, firstPod, nodes))
	return nil
}
