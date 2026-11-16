package components

import (
	"strings"
	"testing"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
)

func stubReadyNodes(t *testing.T, n int) {
	t.Helper()
	old := partialReadyNodes
	t.Cleanup(func() { partialReadyNodes = old })
	partialReadyNodes = func() int { return n }
}

func TestHAPartialCluster(t *testing.T) {
	ha := &config.Config{Profile: config.ProfileHA}
	for _, tc := range []struct {
		nodes   int
		partial bool
	}{{1, true}, {2, true}, {3, false}, {4, false}, {0, false}} {
		stubReadyNodes(t, tc.nodes)
		if got, _ := haPartialCluster(ha); got != tc.partial {
			t.Errorf("%d nodes: partial=%v, want %v", tc.nodes, got, tc.partial)
		}
	}
	stubReadyNodes(t, 1)
	if got, _ := haPartialCluster(&config.Config{Profile: config.ProfileStandard}); got {
		t.Fatal("single-node profiles are never partial ha clusters")
	}
}

func TestPartialMemberNoticeNamesTheNextStep(t *testing.T) {
	msg := partialMemberNotice("MongoDB", "mongodb-0", 1)
	for _, want := range []string{"mongodb-0 is ready", "1 of 3 nodes Ready", "platformctl join --role server", "platformctl install longhorn"} {
		if !strings.Contains(msg, want) {
			t.Fatalf("notice lacks %q: %s", want, msg)
		}
	}
}

func TestPGPluginRolloutEnvOnPartialCluster(t *testing.T) {
	ha := &config.Config{Profile: config.ProfileHA}
	stubReadyNodes(t, 1)
	if env := pgPluginRolloutEnv(ha); env["PG_READY_WANT"] != "1" {
		t.Fatalf("env=%v", env)
	}
	stubReadyNodes(t, 3)
	if env := pgPluginRolloutEnv(ha); env != nil {
		t.Fatalf("full cluster must wait for every instance: %v", env)
	}
}

// pgRolloutFakeKubectl answers the rollout script's two queries.
const pgRolloutFakeKubectl = `
kubectl() {
  case "$*" in
    *clusters.postgresql.cnpg.io*) printf '%s' "$CLUSTER" ;;
    *"get pods"*) printf '%b' "$PODS" ;;
  esac
}
seq() { echo 1; echo 2; }
sleep() { :; }
`

func TestPGPluginRolloutScriptPartialCluster(t *testing.T) {
	// One node: the primary runs the plugin, two standbys are Pending.
	pods := `PODS='postgresql-1=postgres plugin-barman-cloud bootstrap-controller\npostgresql-2=postgres plugin-barman-cloud bootstrap-controller\npostgresql-3=postgres plugin-barman-cloud bootstrap-controller\n'`
	cluster := `CLUSTER='Waiting for the instances to become active/1/3'`
	script := pgRolloutFakeKubectl + pods + "\n" + cluster + "\n"
	if out, err := runJobShell(t, script+pgPluginRolloutScript); err == nil {
		t.Fatalf("without PG_READY_WANT the script must keep waiting for 3 instances: %s", out)
	}
	if out, err := runJobShell(t, script+"PG_READY_WANT=1\n"+pgPluginRolloutScript); err != nil {
		t.Fatalf("partial cluster with the primary ready must pass: %v %s", err, out)
	}
	// The primary has not restarted with the sidecar yet: keep waiting.
	old := `PODS='postgresql-1=postgres bootstrap-controller\n'`
	if out, err := runJobShell(t, pgRolloutFakeKubectl+old+"\n"+cluster+"\nPG_READY_WANT=1\n"+pgPluginRolloutScript); err == nil {
		t.Fatalf("an instance without the plugin must not pass: %s", out)
	}
	// Full cluster, healthy: passes without PG_READY_WANT as before.
	healthy := `CLUSTER='Cluster in healthy state/3/3'`
	if out, err := runJobShell(t, pgRolloutFakeKubectl+pods+"\n"+healthy+"\n"+pgPluginRolloutScript); err != nil {
		t.Fatalf("healthy cluster: %v %s", err, out)
	}
}
