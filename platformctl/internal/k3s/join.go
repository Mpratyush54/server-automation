package k3s

import (
	"fmt"
	"strings"
	"time"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/shell"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/state"
)

// Keep host effects replaceable so join branching can be tested without root.
var (
	joinWriteToken      = WriteTokenFile
	joinWriteConfig     = WriteConfig
	joinWriteRegistries = WriteRegistries
	joinInstall         = installK3s
	joinIsInstalled     = IsInstalled
	joinRestart         = func(service string) error { return shell.RunBash("systemctl restart " + shellQuote(service)) }
	joinWaitReady       = WaitReady
	joinSetupKubeconfig = setupKubeconfig
	joinWaitAgent       = func() error {
		return shell.RunBash(`for i in $(seq 1 60); do
  systemctl is-active --quiet k3s-agent && exit 0
  sleep 2
done
echo "k3s-agent did not become active in time" >&2
exit 1`)
	}
	runRotate = func() error { return shell.RunBash("k3s token rotate") }
	runCreate = func(ttl string) (string, error) {
		return shell.Output("k3s", "token", "create", "--ttl", ttl, "--description", "platformctl-join")
	}
)

// installExec prefixes the install script with INSTALL_K3S_EXEC (e.g. agent).
func installExec(exec string) string {
	if exec == "" {
		return ""
	}
	return "INSTALL_K3S_EXEC=" + shellQuote(exec) + " "
}

// Join installs k3s on this node and joins the cluster at serverURL as a
// server (embedded etcd member) or agent. The token is written to a 0600 token
// file referenced from config.yaml and is never printed.
func Join(role Role, serverURL, token, githubToken string, o ServerOptions) (err error) {
	normalized, err := ValidateServerURL(serverURL)
	if err != nil {
		return err
	}
	token, err = ParseToken([]byte(token))
	if err != nil {
		return err
	}
	// Host errors may include subprocess output. Never return the join secret.
	defer func() {
		if err != nil && strings.Contains(err.Error(), token) {
			err = fmt.Errorf("%s", strings.ReplaceAll(err.Error(), token, "[redacted]"))
		}
	}()
	path, service, exec := ServerTokenFile, "k3s", ""
	var content string
	switch role {
	case RoleServer:
		o.HA, o.ClusterInit, o.ServerURL = true, false, normalized
		o.TokenFile, o.AgentTokenFile = ServerTokenFile, ""
		if err := o.Validate(); err != nil {
			return err
		}
		content = RenderServerConfig(o)
	case RoleAgent:
		path, service, exec = AgentTokenFile, "k3s-agent", "agent"
		// Validate the shared node IP before writing anything on the host.
		check := ServerOptions{HA: true, ClusterInit: true, TokenFile: path, NodeIP: o.NodeIP}
		if err := check.Validate(); err != nil {
			return err
		}
		content = RenderAgentConfig(AgentOptions{normalized, path, o.NodeIP})
	default:
		return fmt.Errorf("invalid role")
	}
	if err := joinWriteToken(path, token); err != nil {
		return err
	}
	registriesChanged, err := joinWriteRegistries(githubToken)
	if err != nil {
		return err
	}
	changed, err := joinWriteConfig(content, upstreamDNS())
	if err != nil {
		return err
	}
	if !joinIsInstalled() {
		if err := joinInstall(exec); err != nil {
			return err
		}
	} else if changed || registriesChanged {
		if err := joinRestart(service); err != nil {
			return err
		}
	}
	if role == RoleServer {
		if err := joinWaitReady(); err != nil {
			return err
		}
		if err := joinSetupKubeconfig(); err != nil {
			return err
		}
	} else if err := joinWaitAgent(); err != nil {
		return err
	}
	if err := state.Set("cluster-role", string(role)); err != nil {
		return err
	}
	return state.MarkDone("k3s")
}

// RotateServerToken runs `k3s token rotate` without --new-token: k3s generates
// the token server side and writes it to its data dir, so no secret is on
// argv. The token file is updated for the next restart of this server.
func RotateServerToken() (string, error) {
	old, err := ReadSecureToken(RoleServer)
	if err != nil {
		return "", err
	}
	if err := runRotate(); err != nil {
		return "", fmt.Errorf("rotate server token failed")
	}
	token, err := ReadSecureToken(RoleServer)
	if err != nil {
		return "", err
	}
	if token == old {
		return "", fmt.Errorf("server token did not change after rotation")
	}
	if err := WriteTokenFile(ServerTokenFile, token); err != nil {
		return "", err
	}
	return token, nil
}

// CreateBootstrapToken creates an expiring agent bootstrap token.
func CreateBootstrapToken(ttl string) (string, error) {
	duration, err := time.ParseDuration(ttl)
	if err != nil || duration < 10*time.Minute || duration > 720*time.Hour {
		return "", fmt.Errorf("token TTL must be between 10m and 720h")
	}
	out, err := runCreate(ttl)
	// Subprocess output and errors can contain credentials; do not repeat them.
	if err != nil {
		return "", fmt.Errorf("create bootstrap token failed")
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	return ParseToken([]byte(lines[len(lines)-1]))
}

// InstallToken stores a rotated token on this node and restarts k3s.
func InstallToken(role Role, token string) error {
	token, err := ParseToken([]byte(token))
	if err != nil {
		return err
	}
	path, service := ServerTokenFile, "k3s"
	if role == RoleAgent {
		path, service = AgentTokenFile, "k3s-agent"
	} else if role != RoleServer {
		return fmt.Errorf("invalid role")
	}
	if err := WriteTokenFile(path, token); err != nil {
		return err
	}
	return joinRestart(service)
}
