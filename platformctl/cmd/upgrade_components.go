package cmd

// Component reconcile after a release upgrade.
//
// The release transaction (backup -> migrations -> charts -> images -> health)
// only changes what is already installed. A release can also add components
// to a profile (full-profile telemetry, synthetics) or change the Helm values
// of existing ones (database metrics exporters). After the release is healthy,
// `platformctl upgrade` brings the install to the configured profile's
// component set with the same step functions `provision` uses, and prints the
// plan — including which workloads restart — before asking for confirmation.

import (
	"fmt"
	"io"
	"strings"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/components"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/state"
)

type componentChange struct {
	Step     string `json:"step"`
	Action   string `json:"action"`
	Restarts string `json:"restarts,omitempty"`
	fn       func(*config.Config) error
}

// stepMarker is the done marker each graph step records ("" = none).
var stepMarker = map[string]string{"ingress-nginx": "ingress", "ingress": "", "storage-scoped": ""}

// reappliedSteps are idempotent and re-applied on every upgrade so value
// changes in a release reach existing installs; Helm/kubectl only restart
// workloads whose rendered templates changed.
var reappliedSteps = map[string]string{
	// Secrets, RBAC and Deployment spec of the target release (the transaction
	// only swaps images); same digest-pinned images, migrations re-run.
	"platform":       "platform-api and platform-portal (rolling, one pod at a time) when the Deployment spec or configuration changed",
	"storage-scoped": "platform-api, only when scoped MinIO credentials are created",
	"ingress-nginx": "ingress-nginx controller, only if its values changed",
	"telemetry":     "Grafana/Prometheus/Loki/Tempo/Pyroscope/Alloy/profile-ingest, only where values changed",
	"synthetics":    "none (namespace, policies and runner config)",
	"kyverno":       "Kyverno controllers, only if their values changed",
}

var installRestarts = map[string]string{
	"telemetry":  "Grafana and Prometheus (kube-prometheus values change); legacy loki-stack without a volume is replaced",
	"synthetics": "none",
}

// componentPlan lists what the reconcile does for the configured profile.
// Steps already done that the release transaction covers (platform, seed,
// auto-update, routing, ...) are not re-run.
func componentPlan(c *config.Config) []componentChange {
	dbs := map[string]interface {
		Status() components.ReleaseStatus
	}{}
	restarts := map[string]string{}
	for _, r := range components.DatabaseReleases(c) {
		dbs[r.Step] = r
		restarts[r.Step] = r.Restarts
	}
	var out []componentChange
	for _, s := range provisionGraph(c) {
		if s.skip || s.fn == nil {
			continue
		}
		ch := componentChange{Step: s.name, fn: s.fn}
		marker, ok := stepMarker[s.name]
		if !ok {
			marker = s.name
		}
		switch {
		case dbs[s.name] != nil:
			switch dbs[s.name].Status() {
			case components.StatusInstall:
				ch.Action = "install"
			case components.StatusReconcile:
				ch.Action, ch.Restarts = "reconcile (Helm values changed)", restarts[s.name]
			default:
				continue
			}
		case marker != "" && !state.IsDone(marker):
			ch.Action, ch.Restarts = "install", installRestarts[s.name]
		case reappliedSteps[s.name] != "":
			ch.Action, ch.Restarts = "re-apply", reappliedSteps[s.name]
		default:
			continue
		}
		out = append(out, ch)
	}
	return out
}

func printComponentPlan(w io.Writer, profile string, plan []componentChange) {
	if len(plan) == 0 {
		fmt.Fprintf(w, "Components (profile %s): all installed and current.\n", profile)
		return
	}
	fmt.Fprintf(w, "Components (profile %s) reconciled after the release is healthy:\n", profile)
	for _, ch := range plan {
		line := fmt.Sprintf("  - %-14s %s", ch.Step, ch.Action)
		if ch.Restarts != "" {
			line += "; restarts: " + ch.Restarts
		}
		fmt.Fprintln(w, line)
	}
}

// applyComponentPlan runs the steps in graph order (provisionGraph is
// topologically ordered).
func applyComponentPlan(c *config.Config, release string, plan []componentChange) error {
	for _, ch := range plan {
		if err := ch.fn(c); err != nil {
			return fmt.Errorf("release %s is healthy, but component %s failed: %w; fix the cause and re-run: sudo platformctl upgrade --to %s", release, ch.Step, err, release)
		}
	}
	return nil
}

func profileLabel(c *config.Config) string {
	if p := strings.TrimSpace(string(c.Profile)); p != "" {
		return p
	}
	return "standard"
}
