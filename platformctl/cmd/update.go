package cmd

import (
	"fmt"
	"io"
	"os"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/components"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/ingressha"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/state"
)

// Seams for tests.
var (
	refreshKubeVIP   = func() (bool, error) { return ingressha.Default().RefreshManifest(cfg) }
	clusterInstalled = func() bool { return state.IsDone("platform") }
	updateImages     = func() error {
		// Move host state into Secrets and drop the hostPath before rolling (#20).
		if err := components.PrepareUpdate(cfg); err != nil {
			return err
		}
		return components.UpdateImages(cfg)
	}
)

// refreshLocalKubeVIP brings this server's copy of the kube-vip manifest up to
// the running platformctl release. Upgrades change the cluster from one
// server, but k3s applies each server's own copy whenever it starts there, so
// every server must refresh its copy or a restart reverts kube-vip. A failure
// is reported, not fatal: the cluster keeps the kube-vip it runs.
func refreshLocalKubeVIP(out io.Writer) {
	changed, err := refreshKubeVIP()
	switch {
	case err != nil:
		fmt.Fprintf(out, "WARNING: could not refresh this server's kube-vip manifest: %v\n", err)
	case changed:
		fmt.Fprintf(out, "Refreshed this server's kube-vip manifest (%s); k3s applies it within a minute.\n", ingressha.ManifestPath)
	}
}

// runUpdate is `platformctl update`. On a node that joined the cluster it
// only refreshes the node's own files: the platform images and the host state
// they need are managed from the server that ran provision.
func runUpdate(out io.Writer) error {
	os.Setenv("KUBECONFIG", "/etc/rancher/k3s/k3s.yaml")
	refreshLocalKubeVIP(out)
	if role := joinedRole(); role != "" && !clusterInstalled() {
		fmt.Fprintf(out, "This node joined the cluster as a %s: its local files are up to date. Run `sudo platformctl update` on the first server to roll the platform images.\n", role)
		return nil
	}
	return updateImages()
}
