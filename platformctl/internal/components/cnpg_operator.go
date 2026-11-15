package components

import (
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strings"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/shell"
	"github.com/fatih/color"
)

// The CloudNativePG operator promotes a standby when the primary's node dies.
// On ha it runs two replicas (cnpg-values.yaml), spread over the nodes. The
// operator is installed on the first server before the others join, so both
// replicas start on that one node and stay there: a 3-node test that powered
// off that node had no operator until Kubernetes replaced it, and Postgres
// failover took about 127 s. Restarting the Deployment once more than one node
// is Ready lets the topology spread constraint place the replicas apart.

const (
	cnpgOperatorNamespace  = "cnpg-system"
	cnpgOperatorDeployment = "cnpg-cloudnative-pg"
	cnpgOperatorSelector   = "app.kubernetes.io/name=cloudnative-pg"
	// cnpgOperatorHAReplicas is replicaCount in cnpg-values.yaml on ha.
	cnpgOperatorHAReplicas = 2
)

// cnpgKubectl runs kubectl. Overridable in tests.
var cnpgKubectl = func(args ...string) (string, error) { return shell.Output("kubectl", args...) }

// cnpgOperatorState is what status and the spread step need to know.
type cnpgOperatorState struct {
	Want, Ready int
	// Nodes holds the node of every running operator pod (may repeat).
	Nodes []string
}

func (s cnpgOperatorState) distinctNodes() []string {
	seen := map[string]bool{}
	var out []string
	for _, n := range s.Nodes {
		if n != "" && !seen[n] {
			seen[n] = true
			out = append(out, n)
		}
	}
	sort.Strings(out)
	return out
}

// parseCNPGOperator reads the Deployment and its pods (kubectl -o json).
func parseCNPGOperator(deployJSON, podsJSON []byte) (cnpgOperatorState, error) {
	var s cnpgOperatorState
	var d struct {
		Spec   struct{ Replicas *int }
		Status struct{ ReadyReplicas int }
	}
	if err := json.Unmarshal(deployJSON, &d); err != nil {
		return s, fmt.Errorf("parse operator Deployment: %w", err)
	}
	s.Want, s.Ready = 1, d.Status.ReadyReplicas
	if d.Spec.Replicas != nil {
		s.Want = *d.Spec.Replicas
	}
	var pods struct {
		Items []struct {
			Metadata struct {
				DeletionTimestamp string `json:"deletionTimestamp"`
			}
			Spec   struct{ NodeName string }
			Status struct{ Phase string }
		}
	}
	if err := json.Unmarshal(podsJSON, &pods); err != nil {
		return s, fmt.Errorf("parse operator pods: %w", err)
	}
	for _, p := range pods.Items {
		if p.Status.Phase == "Running" && p.Metadata.DeletionTimestamp == "" {
			s.Nodes = append(s.Nodes, p.Spec.NodeName)
		}
	}
	return s, nil
}

// cnpgOperatorNeedsSpread reports whether every running replica sits on one
// node although at least two replicas are wanted and two nodes are Ready.
func cnpgOperatorNeedsSpread(s cnpgOperatorState, readyNodes int) bool {
	return s.Want >= 2 && readyNodes >= 2 && len(s.Nodes) >= 2 && len(s.distinctNodes()) == 1
}

// cnpgOperatorStatusLine describes the operator for `platformctl status`.
// ok is false when a node failure would delay Postgres failover.
func cnpgOperatorStatusLine(s cnpgOperatorState, ha bool, readyNodes int) (line string, ok bool) {
	nodes := s.distinctNodes()
	line = fmt.Sprintf("CloudNativePG operator: %d/%d ready", s.Ready, s.Want)
	if len(nodes) > 0 {
		line += " on " + strings.Join(nodes, ", ")
	}
	if !ha {
		return line, s.Ready >= 1
	}
	switch {
	case s.Want < cnpgOperatorHAReplicas:
		return line + fmt.Sprintf("; the ha profile runs %d replicas, re-run: sudo platformctl install postgresql", cnpgOperatorHAReplicas), false
	case s.Ready < s.Want:
		return line + "; Postgres failover is slower until every replica is ready", false
	case cnpgOperatorNeedsSpread(s, readyNodes):
		return line + fmt.Sprintf("; all replicas are on one node, so losing it delays Postgres failover. Spread them: kubectl -n %s rollout restart deploy/%s", cnpgOperatorNamespace, cnpgOperatorDeployment), false
	}
	return line, true
}

func readCNPGOperator() (cnpgOperatorState, bool, error) {
	d, err := cnpgKubectl("-n", cnpgOperatorNamespace, "get", "deployment", cnpgOperatorDeployment, "--ignore-not-found", "-o", "json")
	if err != nil {
		return cnpgOperatorState{}, false, fmt.Errorf("%w: %s", err, strings.TrimSpace(d))
	}
	if strings.TrimSpace(d) == "" {
		return cnpgOperatorState{}, false, nil
	}
	p, err := cnpgKubectl("-n", cnpgOperatorNamespace, "get", "pods", "-l", cnpgOperatorSelector, "-o", "json")
	if err != nil {
		return cnpgOperatorState{}, true, fmt.Errorf("%w: %s", err, strings.TrimSpace(p))
	}
	s, err := parseCNPGOperator([]byte(d), []byte(p))
	return s, true, err
}

func readyNodeCount() (int, error) {
	out, err := cnpgKubectl("get", "nodes", "--no-headers")
	if err != nil {
		return 0, fmt.Errorf("list nodes: %w", err)
	}
	return countReadyNodes(out), nil
}

// SpreadCNPGOperator restarts the operator Deployment on ha when all its
// replicas run on one node and another node is Ready, so they land on
// different nodes. It does nothing on other profiles, when the operator is not
// installed yet, or when the replicas are already apart. Only the operator
// restarts; PostgreSQL itself is not touched.
func SpreadCNPGOperator(cfg *config.Config) error {
	if !cfg.IsHA() {
		return nil
	}
	s, found, err := readCNPGOperator()
	if err != nil || !found {
		return err
	}
	nodes, err := readyNodeCount()
	if err != nil {
		return err
	}
	if !cnpgOperatorNeedsSpread(s, nodes) {
		return nil
	}
	color.Cyan("  · CloudNativePG operator replicas all run on %s; restarting them so they spread over the nodes", s.distinctNodes()[0])
	if out, err := cnpgKubectl("-n", cnpgOperatorNamespace, "rollout", "restart", "deployment/"+cnpgOperatorDeployment); err != nil {
		return fmt.Errorf("restart CloudNativePG operator: %w: %s", err, strings.TrimSpace(out))
	}
	if out, err := cnpgKubectl("-n", cnpgOperatorNamespace, "rollout", "status", "deployment/"+cnpgOperatorDeployment, "--timeout=5m"); err != nil {
		return fmt.Errorf("CloudNativePG operator rollout: %w: %s", err, strings.TrimSpace(out))
	}
	return nil
}

// PrintCNPGOperatorStatus prints the operator line of `platformctl status`.
func PrintCNPGOperatorStatus(w io.Writer, cfg *config.Config) {
	s, found, err := readCNPGOperator()
	if err != nil {
		color.New(color.FgYellow).Fprintf(w, "  ⚠ CloudNativePG operator status unavailable: %v\n", err)
		return
	}
	if !found {
		color.New(color.FgRed).Fprintf(w, "  ✗ CloudNativePG operator: deployment %s/%s not found\n", cnpgOperatorNamespace, cnpgOperatorDeployment)
		return
	}
	nodes := 0
	if cfg.IsHA() {
		nodes, _ = readyNodeCount()
	}
	line, ok := cnpgOperatorStatusLine(s, cfg.IsHA(), nodes)
	if ok {
		fmt.Fprintf(w, "  %s\n", line)
		return
	}
	color.New(color.FgYellow).Fprintf(w, "  ⚠ %s\n", line)
}
