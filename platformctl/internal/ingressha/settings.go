package ingressha

import (
	"bufio"
	"bytes"
	"fmt"
	"strings"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
)

// JoinSettingsHeader starts every join settings file.
const JoinSettingsHeader = "# platformctl join settings v1"

// MaxJoinSettingsSize bounds a join settings file read from disk.
const MaxJoinSettingsSize = 4096

// JoinSettings are the cluster-wide ingress HA settings every server must
// share: k3s refuses a server whose `disable` list differs (ServiceLB is off in
// vip mode only), and every server writes the same kube-vip manifest from
// them. They hold no secret: `platformctl token create --role server` prints
// them next to the server token so the operator can hand them to
// `platformctl join --join-settings`, which compares them with its own
// settings before installing k3s.
type JoinSettings struct {
	Mode       string // INGRESS_HA_MODE
	IngressVIP string // INGRESS_VIP
	Interface  string // INGRESS_VIP_INTERFACE ("" = kube-vip autodetect)
	APIVIP     string // API_VIP
}

// joinSettingsKeys is the complete, ordered set of keys a settings file holds.
var joinSettingsKeys = []string{"INGRESS_HA_MODE", "INGRESS_VIP", "INGRESS_VIP_INTERFACE", "API_VIP"}

// JoinSettingsFromConfig extracts the shared settings from a config.
func JoinSettingsFromConfig(c *config.Config) JoinSettings {
	return JoinSettings{
		Mode:       strings.ToLower(strings.TrimSpace(c.IngressHAMode)),
		IngressVIP: strings.TrimSpace(c.IngressVIP),
		Interface:  strings.TrimSpace(c.IngressVIPInterface),
		APIVIP:     strings.TrimSpace(c.APIVIP),
	}
}

func (s JoinSettings) get(key string) string {
	switch key {
	case "INGRESS_HA_MODE":
		return s.Mode
	case "INGRESS_VIP":
		return s.IngressVIP
	case "INGRESS_VIP_INTERFACE":
		return s.Interface
	default:
		return s.APIVIP
	}
}

func (s *JoinSettings) set(key, v string) {
	switch key {
	case "INGRESS_HA_MODE":
		s.Mode = strings.ToLower(v)
	case "INGRESS_VIP":
		s.IngressVIP = v
	case "INGRESS_VIP_INTERFACE":
		s.Interface = v
	default:
		s.APIVIP = v
	}
}

// Render returns the settings file: a header and KEY=VALUE lines, nothing else.
func (s JoinSettings) Render() string {
	var b strings.Builder
	b.WriteString(JoinSettingsHeader + "\n")
	b.WriteString("# Cluster ingress HA settings for `platformctl join --role server --join-settings <file>`. No secrets.\n")
	for _, k := range joinSettingsKeys {
		fmt.Fprintf(&b, "%s=%s\n", k, strings.NewReplacer("\r", "", "\n", "").Replace(s.get(k)))
	}
	return b.String()
}

// ParseJoinSettings reads a file produced by Render. It accepts only the known
// keys, each at most once, and requires the header, so a token file or an
// unrelated .env passed by mistake is refused instead of half-read. Error
// messages never echo line contents.
func ParseJoinSettings(data []byte) (JoinSettings, error) {
	var s JoinSettings
	if len(data) > MaxJoinSettingsSize {
		return s, fmt.Errorf("join settings file is larger than %d bytes", MaxJoinSettingsSize)
	}
	seen := map[string]bool{}
	header := false
	sc := bufio.NewScanner(bytes.NewReader(data))
	for n := 1; sc.Scan(); n++ {
		line := strings.TrimSpace(sc.Text())
		if line == JoinSettingsHeader {
			header = true
			continue
		}
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		k = strings.TrimSpace(k)
		known := false
		for _, want := range joinSettingsKeys {
			known = known || k == want
		}
		if !ok || !known {
			return JoinSettings{}, fmt.Errorf("join settings line %d is not one of %s=<value>; pass the file `platformctl token create --role server` wrote", n, strings.Join(joinSettingsKeys, "|"))
		}
		if seen[k] {
			return JoinSettings{}, fmt.Errorf("join settings: %s appears twice", k)
		}
		seen[k] = true
		s.set(k, strings.TrimSpace(v))
	}
	if err := sc.Err(); err != nil {
		return JoinSettings{}, fmt.Errorf("read join settings: %w", err)
	}
	if !header {
		return JoinSettings{}, fmt.Errorf("not a join settings file (missing %q header)", JoinSettingsHeader)
	}
	if !seen["INGRESS_HA_MODE"] {
		return JoinSettings{}, fmt.Errorf("join settings: INGRESS_HA_MODE missing")
	}
	return s, nil
}

// Mismatches lists the settings in which local differs from cluster. In
// external mode only the mode matters (no VIPs, interface or manifest).
func Mismatches(cluster, local JoinSettings) []string {
	var out []string
	if cluster.Mode != local.Mode {
		out = append(out, fmt.Sprintf("INGRESS_HA_MODE: cluster %q, this node %q", cluster.Mode, local.Mode))
		return out
	}
	if cluster.Mode != config.IngressHAModeVIP {
		return nil
	}
	for _, k := range joinSettingsKeys[1:] {
		if cv, lv := cluster.get(k), local.get(k); cv != lv {
			out = append(out, fmt.Sprintf("%s: cluster %q, this node %q", k, cv, lv))
		}
	}
	return out
}
