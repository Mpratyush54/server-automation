package k3s

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"unicode"
)

// Paths are variables so token lifecycle tests never need root.
var (
	ServerTokenFile    = "/etc/platform/k3s/server-token"
	AgentTokenFile     = "/etc/platform/k3s/agent-token"
	DataTokenFile      = "/var/lib/rancher/k3s/server/token"
	DataAgentTokenFile = "/var/lib/rancher/k3s/server/agent-token"
)

type Role string

const (
	RoleServer Role = "server"
	RoleAgent  Role = "agent"
)

// ParseRole accepts the join roles "server" and "agent".
func ParseRole(s string) (Role, error) {
	r := Role(strings.ToLower(strings.TrimSpace(s)))
	if r != RoleServer && r != RoleAgent {
		return "", fmt.Errorf("role must be server or agent")
	}
	return r, nil
}

// EtcdSnapshots configures k3s' scheduled etcd snapshots and their optional S3 target.
type EtcdSnapshots struct {
	Cron                                                               string
	Retention                                                          int
	S3Endpoint, S3Bucket, S3Region, S3Folder, S3AccessKey, S3SecretKey string
}

func (e EtcdSnapshots) S3Enabled() bool { return e.S3Endpoint != "" && e.S3Bucket != "" }

// ServerOptions selects the k3s server configuration: the zero value is the
// single-node config; HA adds embedded etcd (first server or joiner).
type ServerOptions struct {
	HA                        bool
	ClusterInit               bool
	ServerURL                 string
	TokenFile, AgentTokenFile string
	// AgentToken (join --role server only) is the cluster's agent token from
	// the server join token file. It is written to AgentTokenFile before k3s
	// starts and never rendered into config.yaml.
	AgentToken string
	TLSSANs    []string
	NodeIP     string
	Snapshots  EtcdSnapshots
}

// Validate rejects inconsistent HA settings before anything is written.
func (o ServerOptions) Validate() error {
	if !o.HA {
		return nil
	}
	if o.ClusterInit == (o.ServerURL != "") {
		return fmt.Errorf("HA requires exactly one of cluster-init or server URL")
	}
	if o.TokenFile == "" {
		return fmt.Errorf("HA requires a token file")
	}
	if o.ServerURL != "" {
		if _, err := ValidateServerURL(o.ServerURL); err != nil {
			return err
		}
	}
	for _, san := range o.TLSSANs {
		if err := ValidateSAN(san); err != nil {
			return err
		}
	}
	if o.NodeIP != "" && net.ParseIP(o.NodeIP) == nil {
		return fmt.Errorf("invalid node IP")
	}
	if o.Snapshots.Retention < 0 {
		return fmt.Errorf("snapshot retention must not be negative")
	}
	return nil
}

func yamlQuote(s string) string { return strconv.Quote(s) }

// RenderServerConfig renders /etc/rancher/k3s/config.yaml. The single-node
// base (critical settings that must match on every server) always comes first.
func RenderServerConfig(o ServerOptions) string {
	var b strings.Builder
	b.WriteString(ServerConfigYAML())
	if !o.HA {
		return b.String()
	}
	field := func(k, v string) {
		if v != "" {
			fmt.Fprintf(&b, "%s: %s\n", k, yamlQuote(v))
		}
	}
	if o.ClusterInit {
		b.WriteString("cluster-init: true\n")
	}
	field("server", o.ServerURL)
	field("token-file", o.TokenFile)
	field("agent-token-file", o.AgentTokenFile)
	if len(o.TLSSANs) > 0 {
		b.WriteString("tls-san:\n")
		for _, s := range o.TLSSANs {
			fmt.Fprintf(&b, "  - %s\n", yamlQuote(s))
		}
	}
	field("node-ip", o.NodeIP)
	e := o.Snapshots
	field("etcd-snapshot-schedule-cron", e.Cron)
	if e.Retention > 0 {
		fmt.Fprintf(&b, "etcd-snapshot-retention: %d\n", e.Retention)
	}
	if e.S3Enabled() {
		b.WriteString("etcd-s3: true\n")
		field("etcd-s3-endpoint", e.S3Endpoint)
		field("etcd-s3-bucket", e.S3Bucket)
		field("etcd-s3-region", e.S3Region)
		field("etcd-s3-folder", e.S3Folder)
		field("etcd-s3-access-key", e.S3AccessKey)
		field("etcd-s3-secret-key", e.S3SecretKey)
	}
	return b.String()
}

// AgentOptions configures a joining agent.
type AgentOptions struct{ ServerURL, TokenFile, NodeIP string }

// RenderAgentConfig renders an agent config without server-only keys.
func RenderAgentConfig(o AgentOptions) string {
	s := "# Managed by platformctl\nserver: " + yamlQuote(o.ServerURL) + "\ntoken-file: " + yamlQuote(o.TokenFile) + "\nresolv-conf: " + ResolvConfPath + "\n"
	if o.NodeIP != "" {
		s += "node-ip: " + yamlQuote(o.NodeIP) + "\n"
	}
	return s
}

// ValidateServerURL normalises a join URL to https://host:port (default port 6443).
func ValidateServerURL(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("invalid server URL")
	}
	if u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || strings.Contains(raw, "#") || (u.Path != "" && u.Path != "/") || u.Opaque != "" {
		return "", fmt.Errorf("server URL must be https with a host and no credentials, query, fragment or path")
	}
	host := u.Hostname()
	if strings.Contains(host, ":") && (!strings.HasPrefix(u.Host, "[") || net.ParseIP(host) == nil) {
		return "", fmt.Errorf("invalid IPv6 server host")
	}
	if strings.HasPrefix(u.Host, "[") && net.ParseIP(host) == nil {
		return "", fmt.Errorf("invalid IPv6 server host")
	}
	port := u.Port()
	if port == "" {
		if strings.HasSuffix(u.Host, ":") {
			return "", fmt.Errorf("invalid server port")
		}
		port = "6443"
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 {
		return "", fmt.Errorf("invalid server port")
	}
	return "https://" + net.JoinHostPort(host, strconv.Itoa(n)), nil
}

// ServerHost returns the host of a normalised server URL without port or brackets.
func ServerHost(normalized string) string {
	u, err := url.Parse(normalized)
	if err != nil {
		return ""
	}
	return u.Hostname()
}

// ValidateSAN accepts an IP address or a DNS name for the API certificate.
func ValidateSAN(s string) error {
	if net.ParseIP(s) != nil {
		return nil
	}
	if len(s) == 0 || len(s) > 253 {
		return fmt.Errorf("invalid TLS SAN")
	}
	for _, label := range strings.Split(strings.ToLower(s), ".") {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return fmt.Errorf("invalid TLS SAN")
		}
		for _, c := range label {
			if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') {
				return fmt.Errorf("invalid TLS SAN")
			}
		}
	}
	return nil
}

// GenerateToken returns 32 random bytes, hex encoded.
func GenerateToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// ParseToken validates a single-line token. Errors never include the token.
func ParseToken(data []byte) (string, error) {
	s := strings.TrimSpace(string(data))
	if len(s) == 0 || len(s) > 4096 {
		return "", fmt.Errorf("token must contain 1 to 4096 bytes")
	}
	for _, c := range s {
		if unicode.IsSpace(c) || unicode.IsControl(c) {
			return "", fmt.Errorf("token contains whitespace or control characters")
		}
	}
	return s, nil
}

// ReadToken reads a token from a 0600 file or, for "-", from stdin. Tokens
// never come from argv, where other local users could read them.
func ReadToken(path string, stdin io.Reader) (string, error) {
	b, err := readTokenInput(path, stdin)
	if err != nil {
		return "", err
	}
	return ParseToken(b)
}

// ReadServerJoinTokens reads a server join token file: the server token on the
// first line and, optionally, the cluster's agent token on the second.
//
// Every k3s server must use the same agent token. A first server provisioned
// with agent-token-file but joined servers without it record a different
// agent credential; k3s on such a joined server then refuses to start after
// any restart ("cred/passwd newer than datastore"), found on the 3-node test.
func ReadServerJoinTokens(path string, stdin io.Reader) (server, agent string, err error) {
	b, err := readTokenInput(path, stdin)
	if err != nil {
		return "", "", err
	}
	var lines []string
	for _, l := range strings.Split(string(b), "\n") {
		if l = strings.TrimSpace(l); l != "" {
			lines = append(lines, l)
		}
	}
	if len(lines) == 0 || len(lines) > 2 {
		return "", "", fmt.Errorf("server join token file must hold the server token and, optionally, the agent token on a second line")
	}
	if server, err = ParseToken([]byte(lines[0])); err != nil {
		return "", "", err
	}
	if len(lines) == 2 {
		if agent, err = ParseToken([]byte(lines[1])); err != nil {
			return "", "", fmt.Errorf("agent token (second line): %w", err)
		}
	}
	return server, agent, nil
}

// WriteServerJoinTokenFile writes the server token and, when set, the agent
// token on a second line to a 0600 file.
func WriteServerJoinTokenFile(path, server, agent string) error {
	if err := WriteTokenFile(path, server); err != nil {
		return err
	}
	if agent == "" {
		return nil
	}
	if _, err := ParseToken([]byte(agent)); err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	if _, err := f.WriteString(agent + "\n"); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

func readTokenInput(path string, stdin io.Reader) ([]byte, error) {
	if path == "-" {
		if stdin == nil {
			return nil, fmt.Errorf("token input is missing")
		}
		b, err := io.ReadAll(io.LimitReader(stdin, 8192))
		if err != nil {
			return nil, fmt.Errorf("read token input failed")
		}
		return b, nil
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0077 != 0 {
		return nil, fmt.Errorf("token file permissions are too wide; chmod 600 the token file")
	}
	b, err := io.ReadAll(f)
	if err != nil {
		return nil, err
	}
	return b, nil
}

// WriteTokenFile atomically writes a token file with mode 0600.
func WriteTokenFile(path, token string) error {
	token, err := ParseToken([]byte(token))
	if err != nil {
		return err
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	if err := os.Chmod(dir, 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, ".token-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err := f.Chmod(0600); err != nil {
		f.Close()
		return err
	}
	_, err = f.WriteString(token + "\n")
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(f.Name(), path)
}

// EnsureServerTokens creates the server and agent token files before k3s
// first starts. An existing cluster keeps its server token: its datastore is
// encrypted with it.
func EnsureServerTokens() (bool, error) {
	changed := false
	for _, path := range []string{ServerTokenFile, AgentTokenFile} {
		if b, err := os.ReadFile(path); err == nil {
			if _, err := ParseToken(b); err == nil {
				continue
			}
		} else if !os.IsNotExist(err) {
			return changed, err
		}
		var token string
		var err error
		// Existing datastore encryption depends on the original server token.
		if path == ServerTokenFile {
			if b, readErr := os.ReadFile(DataTokenFile); readErr == nil {
				token, err = ParseToken(b)
			} else if !os.IsNotExist(readErr) {
				err = readErr
			}
		}
		if err != nil {
			return changed, err
		}
		if token == "" {
			token, err = GenerateToken()
			if err != nil {
				return changed, err
			}
		}
		if err := WriteTokenFile(path, token); err != nil {
			return changed, err
		}
		changed = true
	}
	return changed, nil
}

// TokenCAHash extracts the cluster CA hash of a secure-format (K10) token.
func TokenCAHash(token string) (string, bool) {
	if !strings.HasPrefix(token, "K10") {
		return "", false
	}
	hash, credentials, ok := strings.Cut(token[3:], "::")
	user, password, credOK := strings.Cut(credentials, ":")
	if !ok || !credOK || user == "" || password == "" || len(hash) != 64 {
		return "", false
	}
	if _, err := hex.DecodeString(hash); err != nil {
		return "", false
	}
	return hash, true
}

// CAHashMatches reports whether the token is pinned to this CA bundle (short
// tokens carry no pin and always match).
func CAHashMatches(token string, cacerts []byte) bool {
	hash, ok := TokenCAHash(token)
	if !ok {
		return true
	}
	sum := sha256.Sum256(cacerts)
	return strings.EqualFold(hash, hex.EncodeToString(sum[:]))
}

// ReadSecureToken reads the secure token k3s wrote for the role.
func ReadSecureToken(role Role) (string, error) {
	path := DataTokenFile
	if role == RoleAgent {
		path = DataAgentTokenFile
	} else if role != RoleServer {
		return "", fmt.Errorf("invalid role")
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return ParseToken(b)
}

// NodeInfo is one node of `kubectl get nodes -o json`.
type NodeInfo struct {
	Name       string
	Roles      []string
	Ready      bool
	InternalIP string
	Version    string
}

// ParseNodes parses `kubectl get nodes -o json`, sorted by name.
func ParseNodes(data []byte) ([]NodeInfo, error) {
	var list struct {
		Items []struct {
			Metadata struct {
				Name   string
				Labels map[string]string
			}
			Status struct {
				Conditions []struct{ Type, Status string }
				Addresses  []struct{ Type, Address string }
				NodeInfo   struct{ KubeletVersion string }
			}
		}
	}
	if err := json.Unmarshal(data, &list); err != nil {
		return nil, err
	}
	nodes := make([]NodeInfo, 0, len(list.Items))
	for _, item := range list.Items {
		n := NodeInfo{Name: item.Metadata.Name, Version: item.Status.NodeInfo.KubeletVersion}
		for key := range item.Metadata.Labels {
			if role, ok := strings.CutPrefix(key, "node-role.kubernetes.io/"); ok {
				n.Roles = append(n.Roles, role)
			}
		}
		sort.Strings(n.Roles)
		for _, c := range item.Status.Conditions {
			if c.Type == "Ready" {
				n.Ready = c.Status == "True"
			}
		}
		for _, a := range item.Status.Addresses {
			if a.Type == "InternalIP" {
				n.InternalIP = a.Address
				break
			}
		}
		nodes = append(nodes, n)
	}
	sort.Slice(nodes, func(i, j int) bool { return nodes[i].Name < nodes[j].Name })
	return nodes, nil
}

// EtcdMembers counts nodes with the etcd role.
func EtcdMembers(nodes []NodeInfo) int {
	n := 0
	for _, node := range nodes {
		for _, role := range node.Roles {
			if role == "etcd" {
				n++
				break
			}
		}
	}
	return n
}

// QuorumWarning explains when the etcd server count cannot tolerate a failure.
func QuorumWarning(n int) string {
	switch n {
	case 1:
		return "1 etcd server: the cluster is not highly available until 3 servers have joined"
	case 2:
		return "2 etcd servers: losing either one loses quorum; join a third server"
	}
	if n >= 4 && n%2 == 0 {
		return fmt.Sprintf("%d etcd servers: an even count tolerates no more failures than %d; use an odd number", n, n-1)
	}
	return ""
}
