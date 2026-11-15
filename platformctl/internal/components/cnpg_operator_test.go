package components

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
)

const cnpgDeploy2 = `{"spec":{"replicas":2},"status":{"readyReplicas":2}}`

func cnpgPods(nodes ...string) string {
	var items []string
	for _, n := range nodes {
		items = append(items, `{"spec":{"nodeName":"`+n+`"},"status":{"phase":"Running"}}`)
	}
	return `{"items":[` + strings.Join(items, ",") + `]}`
}

func TestCNPGOperatorValuesPerProfile(t *testing.T) {
	ha := cnpgValues(&config.Config{Profile: config.ProfileHA})
	if !strings.Contains(ha, "replicaCount: 2") || !strings.Contains(ha, "topologyKey: kubernetes.io/hostname") {
		t.Fatalf("ha operator values need 2 replicas spread per node:\n%s", ha)
	}
	for _, p := range []string{config.ProfileStandard, config.ProfileFull, config.ProfileMinimal} {
		v := cnpgValues(&config.Config{Profile: p})
		if !strings.Contains(v, "replicaCount: 1") || strings.Contains(v, "replicaCount: 2") {
			t.Fatalf("%s profile must run one operator replica:\n%s", p, v)
		}
	}
}

func TestParseCNPGOperator(t *testing.T) {
	pods := `{"items":[
	 {"spec":{"nodeName":"a"},"status":{"phase":"Running"}},
	 {"metadata":{"deletionTimestamp":"2026-11-15T00:00:00Z"},"spec":{"nodeName":"b"},"status":{"phase":"Running"}},
	 {"spec":{"nodeName":""},"status":{"phase":"Pending"}}]}`
	s, err := parseCNPGOperator([]byte(`{"spec":{"replicas":2},"status":{"readyReplicas":1}}`), []byte(pods))
	if err != nil || s.Want != 2 || s.Ready != 1 || len(s.Nodes) != 1 || s.Nodes[0] != "a" {
		t.Fatalf("%+v %v", s, err)
	}
	if _, err := parseCNPGOperator([]byte("x"), []byte(pods)); err == nil {
		t.Fatal("accepted bad Deployment JSON")
	}
}

func TestCNPGOperatorNeedsSpread(t *testing.T) {
	for _, tc := range []struct {
		name  string
		want  int
		nodes []string
		ready int
		exp   bool
	}{
		{"both on first server after joins", 2, []string{"a", "a"}, 3, true},
		{"already spread", 2, []string{"a", "b"}, 3, false},
		{"one node only", 2, []string{"a", "a"}, 1, false},
		{"single replica profile", 1, []string{"a"}, 3, false},
		{"one replica still starting", 2, []string{"a"}, 3, false},
	} {
		s := cnpgOperatorState{Want: tc.want, Ready: len(tc.nodes), Nodes: tc.nodes}
		if got := cnpgOperatorNeedsSpread(s, tc.ready); got != tc.exp {
			t.Errorf("%s: got %v", tc.name, got)
		}
	}
}

func TestCNPGOperatorStatusLine(t *testing.T) {
	line, ok := cnpgOperatorStatusLine(cnpgOperatorState{Want: 2, Ready: 2, Nodes: []string{"b", "a"}}, true, 3)
	if !ok || line != "CloudNativePG operator: 2/2 ready on a, b" {
		t.Fatalf("%q %v", line, ok)
	}
	line, ok = cnpgOperatorStatusLine(cnpgOperatorState{Want: 2, Ready: 2, Nodes: []string{"a", "a"}}, true, 3)
	if ok || !strings.Contains(line, "all replicas are on one node") || !strings.Contains(line, "rollout restart deploy/cnpg-cloudnative-pg") {
		t.Fatalf("colocated replicas not flagged: %q", line)
	}
	line, ok = cnpgOperatorStatusLine(cnpgOperatorState{Want: 1, Ready: 1, Nodes: []string{"a"}}, true, 3)
	if ok || !strings.Contains(line, "runs 2 replicas") {
		t.Fatalf("single replica on ha not flagged: %q", line)
	}
	line, ok = cnpgOperatorStatusLine(cnpgOperatorState{Want: 2, Ready: 1, Nodes: []string{"a"}}, true, 3)
	if ok || !strings.Contains(line, "1/2 ready") {
		t.Fatalf("missing replica not flagged: %q", line)
	}
	if line, ok = cnpgOperatorStatusLine(cnpgOperatorState{Want: 1, Ready: 1, Nodes: []string{"a"}}, false, 1); !ok {
		t.Fatalf("one replica is right off ha: %q", line)
	}
}

// fakeCNPGKubectl answers the operator, pod and node queries and records the
// other kubectl calls.
func fakeCNPGKubectl(t *testing.T, deploy, pods, nodes string) *[]string {
	t.Helper()
	old, oldWait := cnpgKubectl, waitBarmanPlugin
	t.Cleanup(func() { cnpgKubectl, waitBarmanPlugin = old, oldWait })
	var calls []string
	waitBarmanPlugin = func() error { calls = append(calls, "wait barman-cloud leader"); return nil }
	cnpgKubectl = func(args ...string) (string, error) {
		joined := strings.Join(args, " ")
		switch {
		case strings.Contains(joined, "get deployment"):
			return deploy, nil
		case strings.Contains(joined, "get pods"):
			return pods, nil
		case strings.HasPrefix(joined, "get nodes"):
			return nodes, nil
		}
		calls = append(calls, joined)
		return "", nil
	}
	return &calls
}

const threeReadyNodes = "a Ready control-plane,etcd 1d v1\nb Ready control-plane,etcd 1d v1\nc Ready control-plane,etcd 1d v1\n"

func TestSpreadCNPGOperatorRestartsColocatedReplicas(t *testing.T) {
	calls := fakeCNPGKubectl(t, cnpgDeploy2, cnpgPods("a", "a"), threeReadyNodes)
	if err := SpreadCNPGOperator(&config.Config{Profile: config.ProfileHA}); err != nil {
		t.Fatal(err)
	}
	got := strings.Join(*calls, "\n")
	if !strings.Contains(got, "-n cnpg-system rollout restart deployment/cnpg-cloudnative-pg") || !strings.Contains(got, "rollout status deployment/cnpg-cloudnative-pg") {
		t.Fatalf("operator not restarted: %s", got)
	}
}

func TestSpreadCNPGOperatorLeavesOtherCasesAlone(t *testing.T) {
	for name, tc := range map[string]struct {
		cfg                 *config.Config
		deploy, pods, nodes string
	}{
		"already spread":     {&config.Config{Profile: config.ProfileHA}, cnpgDeploy2, cnpgPods("a", "b"), threeReadyNodes},
		"not installed yet":  {&config.Config{Profile: config.ProfileHA}, "", "", threeReadyNodes},
		"first server alone": {&config.Config{Profile: config.ProfileHA}, cnpgDeploy2, cnpgPods("a", "a"), "a Ready control-plane 1d v1\n"},
		"standard profile":   {&config.Config{Profile: config.ProfileStandard}, cnpgDeploy2, cnpgPods("a", "a"), threeReadyNodes},
	} {
		calls := fakeCNPGKubectl(t, tc.deploy, tc.pods, tc.nodes)
		if err := SpreadCNPGOperator(tc.cfg); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if len(*calls) != 0 {
			t.Fatalf("%s: unexpected kubectl calls %v", name, *calls)
		}
	}
}

// The operator skips every Cluster whose plugin it cannot reach, failover
// included, so a Barman Cloud plugin stuck on one node is spread too.
func TestSpreadCNPGOperatorSpreadsBarmanPlugin(t *testing.T) {
	old := cnpgKubectl
	t.Cleanup(func() { cnpgKubectl = old })
	var calls []string
	cnpgKubectl = func(args ...string) (string, error) {
		joined := strings.Join(args, " ")
		switch {
		case strings.Contains(joined, "get deployment cnpg-cloudnative-pg"):
			return cnpgDeploy2, nil
		case strings.Contains(joined, "get pods -l "+cnpgOperatorSelector):
			return cnpgPods("a", "b"), nil
		case strings.Contains(joined, "get deployment barman-cloud"):
			// Leader plus hot standby: the standby never turns Ready.
			return `{"spec":{"replicas":2},"status":{"readyReplicas":1}}`, nil
		case strings.Contains(joined, "get pods -l app=barman-cloud"):
			return cnpgPods("a", "a"), nil
		case strings.HasPrefix(joined, "get nodes"):
			return threeReadyNodes, nil
		}
		calls = append(calls, joined)
		return "", nil
	}
	oldWait := waitBarmanPlugin
	t.Cleanup(func() { waitBarmanPlugin = oldWait })
	waited := 0
	waitBarmanPlugin = func() error { waited++; return nil }
	if err := SpreadCNPGOperator(&config.Config{Profile: config.ProfileHA}); err != nil {
		t.Fatal(err)
	}
	got := strings.Join(calls, "\n")
	if !strings.Contains(got, "rollout restart deployment/barman-cloud") || strings.Contains(got, "restart deployment/cnpg-cloudnative-pg") {
		t.Fatalf("calls: %s", got)
	}
	// rollout status would never finish: the standby replica is never Ready.
	if waited != 1 || strings.Contains(got, "rollout status deployment/barman-cloud") {
		t.Fatalf("waited=%d calls: %s", waited, got)
	}
}

func TestBarmanPluginRolloutScriptNeedsOnlyALeader(t *testing.T) {
	for _, want := range []string{"{.status.readyReplicas}", "ready >= 1", `"$upd" == "$want"`, `"$gen" == "$obs"`} {
		if !strings.Contains(barmanPluginRolloutScript, want) {
			t.Errorf("rollout script lacks %q", want)
		}
	}
	if strings.Contains(barmanPluginReadyScript, "rollout status deploy/barman-cloud") {
		t.Fatal("rollout status waits for the standby replica too, which never turns Ready")
	}
}

func TestBarmanPluginRunsTwoSpreadReplicas(t *testing.T) {
	m := readManifest("barman-cloud-plugin.yaml")
	i := strings.Index(m, "kind: Deployment")
	if i < 0 {
		t.Fatal("no Deployment in barman-cloud-plugin.yaml")
	}
	d := m[i:]
	if j := strings.Index(d, "\n---"); j > 0 {
		d = d[:j]
	}
	for _, want := range []string{"replicas: 2", "topologyKey: kubernetes.io/hostname", "whenUnsatisfiable: DoNotSchedule", "periodSeconds: 2"} {
		if !strings.Contains(d, want) {
			t.Errorf("plugin Deployment lacks %q", want)
		}
	}
}

func TestBarmanPluginRolloutScriptRuns(t *testing.T) {
	bash, err := exec.LookPath("bash")
	if err != nil || runtime.GOOS == "windows" {
		t.Skip("needs bash")
	}
	for name, tc := range map[string]struct {
		status string
		ok     bool
	}{
		"leader ready, standby not":  {"3 3 2 2 1", true},
		"old template still rolling": {"3 3 2 1 1", false},
		"not observed yet":           {"4 3 2 2 1", false},
		"no ready pod":               {"3 3 2 2 ", false},
	} {
		dir := t.TempDir()
		fake := "#!/bin/sh\necho '" + tc.status + "'\n"
		if err := os.WriteFile(filepath.Join(dir, "kubectl"), []byte(fake), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "sleep"), []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
			t.Fatal(err)
		}
		cmd := exec.Command(bash, "-c", barmanPluginRolloutScript)
		cmd.Env = append(os.Environ(), "PATH="+dir+string(os.PathListSeparator)+os.Getenv("PATH"))
		err := cmd.Run()
		if (err == nil) != tc.ok {
			t.Errorf("%s: err=%v, want ok=%v", name, err, tc.ok)
		}
	}
}
