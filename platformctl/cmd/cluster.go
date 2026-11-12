package cmd

import (
	"fmt"
	"io"
	"net/netip"
	"os"
	"runtime"
	"strings"

	"github.com/fatih/color"
	"github.com/spf13/cobra"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/harden"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/ingressha"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/k3s"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/preflight"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/shell"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/state"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/versions"
)

// clusterRoleKey records how this node joined the cluster (state file):
// "server" or "agent" for nodes added with `platformctl join`. The first
// server of an HA cluster has no role entry: it is a regular provisioned host.
const clusterRoleKey = "cluster-role"

// joinedRole returns the role of a node added with `platformctl join` ("" otherwise).
var joinedRole = func() string { return state.Get(clusterRoleKey) }

var (
	joinRole, joinServer, joinTokenFile, joinNodes, joinNodeIP string
	tokenRole, tokenTTL, tokenOutput, tokenFile                string
	tokenSettingsOutput                                        string
	// Ingress HA settings of a joining server ("" = keep the environment's).
	joinIngressHAMode, joinIngressVIP, joinIngressVIPIface, joinAPIVIP string
	joinSettingsFile                                                   string
)

var joinCmd = &cobra.Command{
	Use:   "join",
	Short: "Join this node to an HA cluster (ha profile) as a server or agent",
	Long: `Installs k3s on a fresh node and joins it to an existing HA cluster.

The token is read from a file (mode 0600) or from standard input with
--token-file -; it is never accepted on the command line. Create it on an
existing server with:

  sudo platformctl token create --role agent --ttl 2h --output /root/agent.token

A joining server must use the cluster's ingress HA settings (k3s refuses a
server whose ServiceLB setting differs). Pass the settings file written by
"platformctl token create --role server --settings-output <file>" with
--join-settings: join compares it with this node's settings and stops before
installing anything when they differ. Agents ignore these settings.

See docs/operations/ha.md.`,
	RunE: func(cmd *cobra.Command, args []string) error { return runJoin(os.Stdin) },
}

var tokenCmd = &cobra.Command{
	Use:   "token",
	Short: "Manage HA cluster join tokens",
}

var tokenCreateCmd = &cobra.Command{
	Use:   "create",
	Short: "Print a join token once (server token, static agent token or an expiring agent bootstrap token)",
	RunE: func(cmd *cobra.Command, args []string) error {
		return runTokenCreate(os.Stdout)
	},
}

var tokenRotateCmd = &cobra.Command{
	Use:   "rotate",
	Short: "Rotate the server token (k3s token rotate) and print the new token once",
	RunE: func(cmd *cobra.Command, args []string) error {
		return runTokenRotate(os.Stdout)
	},
}

var tokenInstallCmd = &cobra.Command{
	Use:   "install",
	Short: "Store a rotated token on this node and restart k3s",
	RunE: func(cmd *cobra.Command, args []string) error {
		return runTokenInstall(os.Stdin)
	},
}

func init() {
	joinCmd.Flags().StringVar(&joinRole, "role", "agent", "server (etcd member) or agent (workloads only)")
	joinCmd.Flags().StringVar(&joinServer, "server", "", "existing server or API VIP: https://<host>:6443")
	joinCmd.Flags().StringVar(&joinTokenFile, "token-file", "", "file holding the join token (mode 0600), or - for standard input")
	joinCmd.Flags().StringVar(&joinNodes, "nodes", "", "cluster node IPs/CIDRs for the firewall (default PLATFORM_CLUSTER_NODES)")
	joinCmd.Flags().StringVar(&joinNodeIP, "node-ip", "", "address k3s advertises for this node (default PLATFORM_NODE_IP)")
	joinCmd.Flags().BoolVar(&cfg.SkipPreflight, "skip-preflight", cfg.SkipPreflight, "skip the join checks")
	joinCmd.Flags().BoolVar(&cfg.SkipHardening, "skip-hardening", cfg.SkipHardening, "leave host security to the operator (PLATFORM_HARDEN=false)")
	joinCmd.Flags().StringVar(&joinIngressHAMode, "ingress-ha-mode", "", "servers: vip or external, as on the cluster (default INGRESS_HA_MODE)")
	joinCmd.Flags().StringVar(&joinIngressVIP, "ingress-vip", "", "servers: the cluster's ingress VIP (default INGRESS_VIP)")
	joinCmd.Flags().StringVar(&joinIngressVIPIface, "ingress-vip-interface", "", "servers: the cluster's kube-vip interface name; empty = default-route autodetect (default INGRESS_VIP_INTERFACE)")
	joinCmd.Flags().StringVar(&joinAPIVIP, "api-vip", "", "the cluster's API VIP (default API_VIP)")
	joinCmd.Flags().StringVar(&joinSettingsFile, "join-settings", "", "servers: settings file from 'token create --role server --settings-output'; join refuses when this node's ingress HA settings differ")
	_ = joinCmd.MarkFlagRequired("server")
	_ = joinCmd.MarkFlagRequired("token-file")

	tokenCreateCmd.Flags().StringVar(&tokenRole, "role", "agent", "server or agent")
	tokenCreateCmd.Flags().StringVar(&tokenTTL, "ttl", "", "agent only: create an expiring bootstrap token (e.g. 2h; 10m-720h) instead of printing the static agent token")
	tokenCreateCmd.Flags().StringVar(&tokenOutput, "output", "", "write the token to this file (mode 0600) instead of standard output")
	tokenCreateCmd.Flags().StringVar(&tokenSettingsOutput, "settings-output", "", "server only: write the cluster's join settings (ingress HA mode, VIPs, interface; no secrets) to this file for 'join --join-settings'")
	tokenRotateCmd.Flags().StringVar(&tokenOutput, "output", "", "write the new token to this file (mode 0600) instead of standard output")
	tokenInstallCmd.Flags().StringVar(&tokenRole, "role", "server", "server or agent")
	tokenInstallCmd.Flags().StringVar(&tokenFile, "token-file", "", "file holding the token (mode 0600), or - for standard input")
	_ = tokenInstallCmd.MarkFlagRequired("token-file")

	tokenCmd.AddCommand(tokenCreateCmd, tokenRotateCmd, tokenInstallCmd)
	rootCmd.AddCommand(joinCmd, tokenCmd)
}

// requireRoot is swapped in tests.
var requireRoot = func(what string) error {
	if runtime.GOOS != "linux" || os.Geteuid() != 0 {
		return fmt.Errorf("%s requires Linux and root (sudo platformctl %s)", what, what)
	}
	return nil
}

// k3sServerOptions maps the ha profile settings to the first server's k3s
// options. Single-node profiles get the zero value: exactly today's config.
func k3sServerOptions(c *config.Config) k3s.ServerOptions {
	if !c.IsHA() {
		return k3s.ServerOptions{}
	}
	o := clusterServerOptions(c)
	o.ClusterInit = true
	o.TokenFile = k3s.ServerTokenFile
	o.AgentTokenFile = k3s.AgentTokenFile
	return o
}

// clusterServerOptions are the settings every HA server shares (first server
// and joiners): API SANs, node address and the etcd snapshot schedule/target.
func clusterServerOptions(c *config.Config) k3s.ServerOptions {
	cl := c.Cluster
	return k3s.ServerOptions{
		HA:      true,
		TLSSANs: cl.APISANs,
		NodeIP:  cl.NodeIP,
		Snapshots: k3s.EtcdSnapshots{
			Cron: cl.EtcdSnapshotCron, Retention: cl.EtcdSnapshotRetention,
			S3Endpoint: cl.EtcdS3Endpoint, S3Bucket: cl.EtcdS3Bucket, S3Region: cl.EtcdS3Region,
			S3Folder: cl.EtcdS3Folder, S3AccessKey: cl.EtcdS3AccessKey, S3SecretKey: cl.EtcdS3SecretKey,
		},
	}
}

// clusterPeers parses PLATFORM_CLUSTER_NODES for the firewall. Only the ha
// profile opens cluster ports; other profiles get no peers.
func clusterPeers(c *config.Config) ([]netip.Prefix, error) {
	if !c.IsHA() {
		return nil, nil
	}
	peers, err := harden.ParsePeers(c.Cluster.Nodes)
	if err != nil {
		return nil, fmt.Errorf("PLATFORM_CLUSTER_NODES: %w", err)
	}
	return peers, nil
}

// checkHAProvision validates the ha settings before provision changes anything.
func checkHAProvision(c *config.Config) error {
	if role := joinedRole(); role != "" {
		return fmt.Errorf("this node joined the cluster as %s with `platformctl join`; provision runs on the first server only", role)
	}
	if !c.IsHA() {
		return nil
	}
	peers, err := clusterPeers(c)
	if err != nil {
		return err
	}
	if len(peers) == 0 && !c.SkipHardening {
		return fmt.Errorf("the ha profile with host hardening needs PLATFORM_CLUSTER_NODES (every node's IP, or the private subnet CIDR) so the firewall admits the other nodes; or use --skip-hardening")
	}
	if err := k3sServerOptions(c).Validate(); err != nil {
		return fmt.Errorf("ha settings: %w", err)
	}
	return nil
}

// printJoinHint tells the operator how to grow the cluster after provision.
func printJoinHint(w io.Writer, c *config.Config) {
	if !c.IsHA() {
		return
	}
	fmt.Fprintln(w, "\n  HA cluster: add servers (3 or 5 in total) and agents:")
	fmt.Fprintln(w, "    sudo platformctl token create --role server --output /root/server.token")
	fmt.Fprintln(w, "    sudo platformctl token create --role agent --ttl 2h --output /root/agent.token")
	fmt.Fprintln(w, "  then on each new node (copy the token file first):")
	server := "<this-node>"
	if c.APIVIP != "" {
		server = c.APIVIP
	}
	fmt.Fprintf(w, "    sudo platformctl join --role server|agent --server https://%s:6443 --token-file <file> --nodes %s\n",
		server, strings.Join(c.Cluster.Nodes, ","))
	fmt.Fprintln(w, "  Servers must use this cluster's ingress HA settings; write them next to the server token and pass them to join:")
	fmt.Fprintln(w, "    sudo platformctl token create --role server --output /root/server.token --settings-output /root/join-settings")
	fmt.Fprintln(w, "    sudo platformctl join --role server ... --join-settings /root/join-settings")
	fmt.Fprintln(w, "  After joins, reconcile the Longhorn replica count: sudo platformctl install longhorn")
	fmt.Fprintln(w, "  See docs/operations/ha.md.")
}

// joinPreflight is swapped in tests.
var joinPreflight = func(host, role, token string) *preflight.Result {
	r := preflight.Check()
	o := preflight.JoinOptions{ServerHost: host, Role: role, Token: token, LocalK3sVersion: versions.K3sVersion, ViaAPIVIP: joinViaAPIVIP(host, cfg)}
	if k3s.IsInstalled() {
		// Re-running join on this node: k3s itself holds the local ports.
		o.PortInUse = func(int) bool { return false }
	}
	j := preflight.CheckJoin(o)
	r.Errors = append(r.Errors, j.Errors...)
	r.Warnings = append(r.Warnings, j.Warnings...)
	r.Passed = r.Passed && j.Passed
	return r
}

// Swapped in tests.
var (
	k3sJoin       = k3s.Join
	joinHarden    = func() error { return runHardening() }
	upsertEnvKey  = config.UpsertEnvKey
	provisionedFn = func() bool { return state.IsDone("platform") }
)

func runJoin(stdin io.Reader) error {
	if err := requireRoot("join"); err != nil {
		return err
	}
	role, err := k3s.ParseRole(joinRole)
	if err != nil {
		return err
	}
	serverURL, err := k3s.ValidateServerURL(joinServer)
	if err != nil {
		return fmt.Errorf("--server: %w", err)
	}
	if provisionedFn() {
		return fmt.Errorf("this host already runs the platform; join is for fresh nodes")
	}
	if prev := joinedRole(); prev != "" && prev != string(role) {
		return fmt.Errorf("this node already joined as %s; it cannot rejoin as %s", prev, role)
	}
	token, err := k3s.ReadToken(joinTokenFile, stdin)
	if err != nil {
		return fmt.Errorf("--token-file: %w", err)
	}

	// The node takes the ha profile; flags override the environment.
	if err := cfg.ApplyProfile(config.ProfileHA); err != nil {
		return err
	}
	if joinNodes != "" {
		cfg.Cluster.Nodes = config.SplitList(joinNodes)
	}
	if joinNodeIP != "" {
		cfg.Cluster.NodeIP = strings.TrimSpace(joinNodeIP)
	}
	applyJoinIngressFlags(cfg)
	if role == k3s.RoleServer {
		if err := checkJoinIngressSettings(cfg, joinSettingsFile, os.Stderr); err != nil {
			return err
		}
	} else if joinSettingsFile != "" {
		fmt.Fprintln(os.Stderr, "  Note: --join-settings is ignored on agents (they run no ingress HA config).")
	}
	peers, err := clusterPeers(cfg)
	if err != nil {
		return err
	}
	if len(peers) == 0 && !cfg.SkipHardening {
		return fmt.Errorf("host hardening needs the cluster node addresses for the firewall: pass --nodes (or PLATFORM_CLUSTER_NODES), or --skip-hardening")
	}
	opts := clusterServerOptions(cfg)
	if role == k3s.RoleAgent {
		opts = k3s.ServerOptions{NodeIP: cfg.Cluster.NodeIP}
	}

	unlock, err := state.AcquireLock("join")
	if err != nil {
		return err
	}
	defer unlock()

	if !cfg.SkipPreflight {
		color.Cyan("\n  ■ Join pre-flight checks\n")
		r := joinPreflight(k3s.ServerHost(serverURL), string(role), token)
		preflight.PrintResult(r)
		if !r.Passed {
			return fmt.Errorf("join pre-flight checks failed")
		}
	}

	// Persist what later `harden`/`status` runs on this node need. Not the
	// token: it lives in /etc/platform/k3s (0600), referenced by k3s' config.
	for k, v := range joinEnv(cfg) {
		if err := upsertEnvKey(envFilePath, k, v); err != nil {
			return fmt.Errorf("save %s: %w", envFilePath, err)
		}
	}

	// Host preparation that must precede k3s (Longhorn prerequisites on every
	// node; storage skip file and ingress HA fragment on servers).
	wasInstalled := joinK3sInstalled()
	fragmentChanged := false
	color.Cyan("\n  ■ Preparing this node (%s)...", role)
	if err := runJoinPlan(joinPlan(role, cfg, &fragmentChanged)); err != nil {
		return err
	}

	color.Cyan("\n  ■ Joining %s as %s...", serverURL, role)
	if err := k3sJoin(role, serverURL, token, cfg.GitHubToken, opts); err != nil {
		return err
	}
	// Re-running join on a server whose ingress HA fragment changed: k3s only
	// reads config.yaml.d at start.
	if role == k3s.RoleServer && wasInstalled && fragmentChanged {
		if err := joinRestartServer(); err != nil {
			return err
		}
	}
	color.Green("  ✓ Joined the cluster as %s", role)

	if !cfg.SkipHardening {
		if err := joinHarden(); err != nil {
			return fmt.Errorf("host hardening: %w (k3s joined; fix and run `sudo platformctl harden --auto`)", err)
		}
	}
	printLonghornJoinHint(os.Stdout)
	fmt.Println("\n  Check the cluster from a server: sudo platformctl status")
	return nil
}

// applyJoinIngressFlags lets the join flags override the environment's ingress
// HA settings. A VIP given without a mode re-derives the default mode (vip
// when INGRESS_VIP is set) unless INGRESS_HA_MODE says otherwise.
func applyJoinIngressFlags(c *config.Config) {
	if v := strings.TrimSpace(joinIngressVIP); v != "" {
		c.IngressVIP = v
		if strings.TrimSpace(joinIngressHAMode) == "" && strings.TrimSpace(os.Getenv("INGRESS_HA_MODE")) == "" {
			c.IngressHAMode = config.ResolveIngressHAMode("", v)
		}
	}
	if v := strings.TrimSpace(joinIngressHAMode); v != "" {
		c.IngressHAMode = strings.ToLower(v)
	}
	if v := strings.TrimSpace(joinIngressVIPIface); v != "" {
		c.IngressVIPInterface = v
	}
	if v := strings.TrimSpace(joinAPIVIP); v != "" {
		c.APIVIP = v
	}
}

// checkJoinIngressSettings validates a joining server's ingress HA settings
// and, when a join settings file is given, refuses to continue unless they
// match the cluster's. It runs before any host change. Without credentials
// for the cluster API, the settings file from `token create --role server` is
// the record of the cluster's settings this node can check against.
func checkJoinIngressSettings(c *config.Config, settingsFile string, warn io.Writer) error {
	if err := c.ValidateIngressHA(); err != nil {
		return fmt.Errorf("ingress HA settings: %w", err)
	}
	if settingsFile == "" {
		fmt.Fprintf(warn, "  Warning: no --join-settings file; this server uses INGRESS_HA_MODE=%s without checking it against the cluster.\n", c.IngressHAMode)
		fmt.Fprintln(warn, "  If it differs from the cluster's, k3s refuses to join (critical config mismatch).")
		return nil
	}
	if settingsFile == "-" {
		return fmt.Errorf("--join-settings needs a file path (standard input is reserved for the token)")
	}
	f, err := os.Open(settingsFile)
	if err != nil {
		return fmt.Errorf("--join-settings: %w", err)
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, ingressha.MaxJoinSettingsSize+1))
	if err != nil {
		return fmt.Errorf("--join-settings: %w", err)
	}
	cluster, err := ingressha.ParseJoinSettings(data)
	if err != nil {
		return fmt.Errorf("--join-settings: %w", err)
	}
	if diff := ingressha.Mismatches(cluster, ingressha.JoinSettingsFromConfig(c)); len(diff) > 0 {
		return fmt.Errorf("this server's ingress HA settings differ from the cluster's (k3s would refuse the server, or kube-vip would be configured differently):\n    %s\n  set --ingress-ha-mode, --ingress-vip, --ingress-vip-interface and --api-vip (or the matching environment variables) to the values in %s",
			strings.Join(diff, "\n    "), settingsFile)
	}
	color.Green("  ✓ Ingress HA settings match the cluster (%s)", cluster.Mode)
	return nil
}

// joinEnv are the .env keys a joined node keeps.
func joinEnv(c *config.Config) map[string]string {
	env := map[string]string{
		"PLATFORM_PROFILE":       config.ProfileHA,
		"PLATFORM_CLUSTER_NODES": strings.Join(c.Cluster.Nodes, ","),
		"PLATFORM_NODE_IP":       c.Cluster.NodeIP,
		"PLATFORM_HARDEN":        fmt.Sprintf("%t", !c.SkipHardening),
		// Ingress HA (#54): later `harden` runs need API_VIP for its 6443
		// rule; re-running join must render the same k3s fragment.
		"INGRESS_HA_MODE":       c.IngressHAMode,
		"INGRESS_VIP":           c.IngressVIP,
		"INGRESS_VIP_INTERFACE": c.IngressVIPInterface,
		"API_VIP":               c.APIVIP,
	}
	for k, v := range env {
		env[k] = strings.NewReplacer("\r", "", "\n", "").Replace(v)
	}
	return env
}

// writeToken prints a token once or writes it to a 0600 file. Status text
// goes to stderr so `platformctl token create | ...` pipes only the token.
func writeToken(stdout io.Writer, token, output string) error {
	if output != "" {
		if err := k3s.WriteTokenFile(output, token); err != nil {
			return err
		}
		fmt.Fprintf(os.Stderr, "Token written to %s (mode 0600). Copy it to the new node and delete it afterwards.\n", output)
		return nil
	}
	fmt.Fprintln(os.Stderr, "Join token (shown once; treat it like a root password):")
	_, err := fmt.Fprintln(stdout, token)
	return err
}

// requireServer refuses token management on agents and single-node hosts.
func requireServer() error {
	if joinedRole() == string(k3s.RoleAgent) {
		return fmt.Errorf("run this on a server node, not on an agent")
	}
	if !shell.FileExists(k3s.DataTokenFile) {
		return fmt.Errorf("no k3s server on this node (%s missing)", k3s.DataTokenFile)
	}
	return nil
}

func runTokenCreate(stdout io.Writer) error {
	if err := requireRoot("token"); err != nil {
		return err
	}
	if err := requireServer(); err != nil {
		return err
	}
	role, err := k3s.ParseRole(tokenRole)
	if err != nil {
		return err
	}
	if tokenSettingsOutput != "" && role != k3s.RoleServer {
		return fmt.Errorf("--settings-output applies to server tokens only; agents need no join settings")
	}
	var token string
	switch {
	case role == k3s.RoleServer && tokenTTL != "":
		return fmt.Errorf("--ttl applies to agent tokens only; servers join with the server token")
	case role == k3s.RoleServer:
		token, err = k3s.ReadSecureToken(k3s.RoleServer)
	case tokenTTL != "":
		os.Setenv("KUBECONFIG", "/etc/rancher/k3s/k3s.yaml")
		token, err = k3s.CreateBootstrapToken(tokenTTL)
	default:
		token, err = k3s.ReadSecureToken(k3s.RoleAgent)
	}
	if err != nil {
		return err
	}
	if err := writeToken(stdout, token, tokenOutput); err != nil {
		return err
	}
	if role == k3s.RoleServer {
		return writeJoinSettings(os.Stderr, cfg, tokenSettingsOutput)
	}
	return nil
}

// writeJoinSettings writes the cluster's non-secret join settings to a file,
// or prints them on stderr (stdout carries only the token) with a hint.
func writeJoinSettings(stderr io.Writer, c *config.Config, output string) error {
	body := ingressha.JoinSettingsFromConfig(c).Render()
	if output == "" {
		fmt.Fprintln(stderr, "Join settings for new servers (no secrets). Save them as a file and pass it to")
		fmt.Fprintln(stderr, "`platformctl join --role server --join-settings <file>`, or rerun with --settings-output <file>:")
		fmt.Fprint(stderr, body)
		return nil
	}
	if err := os.WriteFile(output, []byte(body), 0o644); err != nil {
		return fmt.Errorf("--settings-output: %w", err)
	}
	fmt.Fprintf(stderr, "Join settings written to %s (no secrets). Copy it to each new server with the token and pass --join-settings <file>.\n", output)
	return nil
}

func runTokenRotate(stdout io.Writer) error {
	if err := requireRoot("token"); err != nil {
		return err
	}
	if err := requireServer(); err != nil {
		return err
	}
	unlock, err := state.AcquireLock("token-rotate")
	if err != nil {
		return err
	}
	defer unlock()
	token, err := k3s.RotateServerToken()
	if err != nil {
		return err
	}
	if err := writeToken(stdout, token, tokenOutput); err != nil {
		return err
	}
	fmt.Fprintln(os.Stderr, "Server token rotated. On every other server run:")
	fmt.Fprintln(os.Stderr, "  sudo platformctl token install --role server --token-file <file>")
	fmt.Fprintln(os.Stderr, "then restart k3s on this server: sudo systemctl restart k3s")
	fmt.Fprintln(os.Stderr, "Agents joined with the agent token are not affected. Keep the old token for etcd snapshots taken before now.")
	return nil
}

func runTokenInstall(stdin io.Reader) error {
	if err := requireRoot("token"); err != nil {
		return err
	}
	role, err := k3s.ParseRole(tokenRole)
	if err != nil {
		return err
	}
	token, err := k3s.ReadToken(tokenFile, stdin)
	if err != nil {
		return fmt.Errorf("--token-file: %w", err)
	}
	if err := k3s.InstallToken(role, token); err != nil {
		return err
	}
	color.Green("  ✓ Token installed; k3s restarted")
	return nil
}

// printClusterStatus shows nodes, roles and etcd health on HA servers.
func printClusterStatus(w io.Writer) error {
	out, err := shell.Output("k3s", "kubectl", "get", "nodes", "-o", "json", "--request-timeout=10s")
	if err != nil {
		return fmt.Errorf("list nodes: %w", err)
	}
	nodes, err := k3s.ParseNodes([]byte(out))
	if err != nil {
		return err
	}
	etcd := "ok"
	if res, err := shell.Output("k3s", "kubectl", "get", "--raw", "/readyz/etcd", "--request-timeout=10s"); err != nil || strings.TrimSpace(res) != "ok" {
		etcd = "UNHEALTHY"
	}
	writeClusterStatus(w, nodes, etcd)
	return nil
}

func writeClusterStatus(w io.Writer, nodes []k3s.NodeInfo, etcd string) {
	fmt.Fprintf(w, "  Cluster nodes (%d), etcd: %s\n", len(nodes), etcd)
	for _, n := range nodes {
		ready := "Ready"
		if !n.Ready {
			ready = "NotReady"
		}
		roles := strings.Join(n.Roles, ",")
		if roles == "" {
			roles = "agent"
		}
		fmt.Fprintf(w, "    %-24s %-28s %-9s %-15s %s\n", n.Name, roles, ready, n.InternalIP, n.Version)
	}
	if msg := k3s.QuorumWarning(k3s.EtcdMembers(nodes)); msg != "" {
		fmt.Fprintf(w, "  WARNING: %s\n", msg)
	}
}

// agentStatus reports the k3s-agent service on a joined agent (no kubeconfig there).
func agentStatus(w io.Writer) error {
	out, err := shell.Output("systemctl", "is-active", "k3s-agent")
	fmt.Fprintf(w, "  Agent node: k3s-agent %s\n", strings.TrimSpace(out))
	if err != nil {
		return fmt.Errorf("k3s-agent is not active")
	}
	fmt.Fprintln(w, "  Cluster health is reported on the servers: sudo platformctl status")
	return nil
}
