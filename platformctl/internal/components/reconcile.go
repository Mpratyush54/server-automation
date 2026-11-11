package components

// Values-aware reconcile for components guarded by a done marker (#upgrade).
//
// A done marker alone made provision skip the databases forever, so a release
// that changes their Helm values (e.g. adding metrics exporters) never reached
// existing installs. Each such component now records a fingerprint of its
// rendered values ("<step>.values" in the state file); provision and upgrade
// run `helm upgrade` again when the fingerprint differs (or none was recorded).
// Helm only restarts pods whose templates change, so an unchanged rendering
// is a no-op.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"

	"github.com/fatih/color"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/state"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/versions"
)

// helmRelease is one marker-guarded Helm component with its rendered values.
type helmRelease struct {
	Step, Label, Release, Chart, Namespace string
	Values                                 map[string]any
	Args                                   []string
	// Restarts names the workloads a values change restarts (shown in plans).
	Restarts string
}

// redactSecrets replaces credentials so the fingerprint (stored in a
// world-readable state file) never derives from a password. Credential
// rotation has its own flow; this reconciler only tracks configuration.
func redactSecrets(v any) any {
	switch t := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, x := range t {
			if k == "auth" {
				out[k] = "<redacted>"
				continue
			}
			out[k] = redactSecrets(x)
		}
		return out
	case map[string]string:
		out := make(map[string]any, len(t))
		for k, x := range t {
			out[k] = x
		}
		return redactSecrets(out)
	case []any:
		out := make([]any, len(t))
		for i, x := range t {
			out[i] = redactSecrets(x)
		}
		return out
	}
	return v
}

// Fingerprint identifies the chart version, values and extra arguments.
func (r helmRelease) Fingerprint() string {
	b, _ := json.Marshal(redactSecrets(r.Values)) // map keys are sorted
	h := sha256.New()
	h.Write([]byte(versions.Get(r.Chart).Version + "\x00"))
	h.Write(b)
	h.Write([]byte("\x00" + strings.Join(r.Args, "\x00")))
	return hex.EncodeToString(h.Sum(nil))[:16]
}

// ReleaseStatus is what provision/upgrade will do with a component.
type ReleaseStatus string

const (
	StatusInstall   ReleaseStatus = "install"
	StatusReconcile ReleaseStatus = "reconcile"
	StatusCurrent   ReleaseStatus = "up to date"
)

func (r helmRelease) Status() ReleaseStatus {
	if !state.IsDone(r.Step) {
		return StatusInstall
	}
	if state.Get(r.Step+".values") != r.Fingerprint() {
		return StatusReconcile
	}
	return StatusCurrent
}

// reconcile installs the release, upgrades it when its values changed, and
// records the fingerprint with the done marker.
func (r helmRelease) reconcile(extraArgs ...string) error {
	switch r.Status() {
	case StatusCurrent:
		color.Green("  ✓ %s already done", r.Label)
		return nil
	case StatusReconcile:
		color.Cyan("\n  ■ Reconciling %s: its Helm values changed (restarts: %s)...", r.Label, r.Restarts)
	default:
		color.Cyan("\n  ■ Installing %s...", r.Label)
	}
	if err := helmValues(r.Release, r.Chart, r.Namespace, r.Values, append(append([]string{}, r.Args...), extraArgs...)...); err != nil {
		return err
	}
	color.Green("  ✓ %s installed", r.Label)
	if err := state.Set(r.Step+".values", r.Fingerprint()); err != nil {
		return err
	}
	return state.MarkDone(r.Step)
}

func postgresqlRelease(cfg *config.Config) helmRelease {
	return helmRelease{Step: "postgresql", Label: "PostgreSQL", Release: "postgresql", Chart: "postgresql", Namespace: "databases",
		Values:   map[string]any{"auth": map[string]string{"postgresPassword": cfg.PostgresPassword, "database": "platform"}},
		Args:     []string{"--set", "primary.persistence.size=10Gi"},
		Restarts: "postgresql-0 (connections drop for ~30s; the API reconnects)"}
}

func mongodbRelease(cfg *config.Config) helmRelease {
	return helmRelease{Step: "mongodb", Label: "MongoDB", Release: "mongodb", Chart: "mongodb", Namespace: "databases",
		Values:   map[string]any{"auth": map[string]string{"rootPassword": cfg.MongoPassword}},
		Args:     []string{"--set", "persistence.size=10Gi"},
		Restarts: "mongodb (project databases unavailable for ~30s)"}
}

func redisRelease(cfg *config.Config) helmRelease {
	return helmRelease{Step: "redis", Label: "Redis", Release: "redis", Chart: "redis", Namespace: "databases",
		Values: map[string]any{"auth": map[string]string{"password": cfg.RedisPassword}},
		// Single server: one read replica. The chart default (3, started one at a
		// time) added ~1.5 minutes to every install for no redundancy.
		Args:     []string{"--set", "master.persistence.size=5Gi", "--set", "replica.replicaCount=1"},
		Restarts: "redis-master-0, redis-replicas-0 (project Redis users are re-created by the API)"}
}

// DatabaseReleases are the values-reconciled database components.
func DatabaseReleases(cfg *config.Config) []helmRelease {
	return []helmRelease{postgresqlRelease(cfg), mongodbRelease(cfg), redisRelease(cfg)}
}
