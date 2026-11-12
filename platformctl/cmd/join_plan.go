package cmd

import (
	"fmt"
	"io"
	"net/netip"
	"strings"

	"github.com/fatih/color"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/components"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/ingressha"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/k3s"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/shell"
)

// Host effects of the join plan; swapped in tests.
var (
	joinPrepareLonghorn = components.PrepareLonghornNode
	joinStorageSkip     = func() error { return components.WriteLocalStorageSkip("") }
	joinIngressFragment = func(c *config.Config) (bool, error) { return ingressha.Default().PrepareJoinServer(c) }
	joinK3sInstalled    = k3s.IsInstalled
	joinRestartServer   = func() error {
		if err := shell.RunBash("systemctl restart k3s"); err != nil {
			return fmt.Errorf("restart k3s: %w", err)
		}
		return k3s.WaitReady()
	}
)

// joinStep is one host change `platformctl join` makes before k3s starts.
type joinStep struct {
	name string
	run  func() error
}

// joinPlan lists the host preparation a joining node needs before k3s starts,
// so the node matches what provision set up on the first server:
//
//   - every node: Longhorn prerequisites (open-iscsi, iscsid, iscsi_tcp, ...)
//     and the iscsid check; Longhorn places replicas on agents too.
//   - servers only: the local-storage skip file (otherwise this server's k3s
//     restores local-path as a second default StorageClass), the ingress HA
//     k3s config fragment (disable servicelb, tls-san API_VIP), so every server
//     agrees on the ServiceLB setting, which k3s treats as critical, and the
//     kube-vip auto-deploy manifest, identical to the first server's, so it
//     survives the loss of any one server's disk.
//
// fragmentChanged reports whether the server fragment changed on disk.
func joinPlan(role k3s.Role, c *config.Config, fragmentChanged *bool) []joinStep {
	steps := []joinStep{{"longhorn-prereqs", joinPrepareLonghorn}}
	if role != k3s.RoleServer {
		return steps
	}
	return append(steps,
		joinStep{"local-storage-skip", joinStorageSkip},
		joinStep{"ingress-ha-config", func() error {
			changed, err := joinIngressFragment(c)
			if fragmentChanged != nil {
				*fragmentChanged = changed
			}
			return err
		}},
	)
}

// runJoinPlan runs the steps in order and stops at the first failure.
func runJoinPlan(steps []joinStep) error {
	for _, s := range steps {
		color.Cyan("  ■ %s", s.name)
		if err := s.run(); err != nil {
			return fmt.Errorf("%s: %w", s.name, err)
		}
	}
	return nil
}

// joinViaAPIVIP reports whether the join URL's host is the configured API_VIP.
func joinViaAPIVIP(host string, c *config.Config) bool {
	vip, err := netip.ParseAddr(strings.TrimSpace(c.APIVIP))
	if err != nil {
		return false
	}
	h, err := netip.ParseAddr(host)
	return err == nil && h == vip
}

// printLonghornJoinHint reminds the operator to reconcile the Longhorn replica
// count once the new node is Ready: the default StorageClass replica count is
// chosen from the Ready node count when `install longhorn` runs.
func printLonghornJoinHint(w io.Writer) {
	fmt.Fprintln(w, "\n  Longhorn: once this node is Ready, reconcile the replica count on the first server:")
	fmt.Fprintln(w, "    sudo platformctl install longhorn")
	fmt.Fprintln(w, "  Existing volumes keep their replica count; see docs/operations/ha.md.")
}
