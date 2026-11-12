package preflight

import (
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/k3s"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/shell"
)

// ClusterPorts are the TCP ports a joining node needs on the existing server.
func ClusterPorts(role string) []int {
	if role == "server" {
		return []int{6443, 2379, 2380, 10250}
	}
	if role == "agent" {
		return []int{6443, 10250}
	}
	return nil
}

// ClockSkew returns the server clock (HTTP Date header) minus the local clock.
func ClockSkew(dateHeader string, now time.Time) (time.Duration, error) {
	server, err := http.ParseTime(dateHeader)
	if err != nil {
		return 0, err
	}
	return server.Sub(now), nil
}

// JoinOptions configures CheckJoin; nil hooks use the real host.
type JoinOptions struct {
	ServerHost      string
	Role            string
	Token           string
	LocalK3sVersion string
	Dial            func(network, addr string, timeout time.Duration) (net.Conn, error)
	Get             func(url string) (int, http.Header, []byte, error)
	Now             func() time.Time
	NTPSynced       func() (bool, error)
	PortInUse       func(int) bool
	// ViaAPIVIP is set when ServerHost is the floating API_VIP (kube-vip).
	// etcd (2379/2380) listens on node addresses only, not on the VIP, so
	// those ports are not dialled through it.
	ViaAPIVIP bool
}

func joinGet(url string) (int, http.Header, []byte, error) {
	// Only public discovery endpoints are read. The token authenticates the CA.
	client := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	defer client.CloseIdleConnections()
	response, err := client.Get(url)
	if err != nil {
		return 0, nil, nil, err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	return response.StatusCode, response.Header, body, err
}

// CheckJoin verifies a node can join before anything changes: reachability,
// token CA pin, clocks, k3s version and free local ports.
func CheckJoin(o JoinOptions) *Result {
	r := &Result{}
	if o.Dial == nil {
		o.Dial = net.DialTimeout
	}
	if o.Get == nil {
		o.Get = joinGet
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.NTPSynced == nil {
		o.NTPSynced = func() (bool, error) {
			out, err := shell.Output("timedatectl", "show", "-p", "NTPSynchronized", "--value")
			return strings.TrimSpace(out) == "yes", err
		}
	}
	if o.PortInUse == nil {
		o.PortInUse = func(port int) bool {
			out, _ := shell.Output("ss", "-tlnH", "sport", "=", ":"+strconv.Itoa(port))
			return strings.TrimSpace(out) != ""
		}
	}
	ports := ClusterPorts(o.Role)
	if len(ports) == 0 {
		r.Errors = append(r.Errors, "role must be server or agent")
		return r
	}
	if o.ViaAPIVIP && o.Role == "server" {
		r.Warnings = append(r.Warnings, fmt.Sprintf("joining through the API VIP %s: etcd ports 2379/2380 are not checked (etcd listens on node addresses); make sure every server admits this node (PLATFORM_CLUSTER_NODES)", o.ServerHost))
	}
	for _, port := range ports {
		if o.ViaAPIVIP && (port == 2379 || port == 2380) {
			continue
		}
		address := net.JoinHostPort(o.ServerHost, strconv.Itoa(port))
		conn, err := o.Dial("tcp", address, 5*time.Second)
		if err != nil {
			r.Errors = append(r.Errors, fmt.Sprintf("cannot reach %s (%s): allow this node's IP in PLATFORM_CLUSTER_NODES on the existing nodes and re-run `platformctl harden` there", address, redactJoinError(err, o.Token)))
		} else if conn != nil {
			conn.Close()
		}
	}
	base := "https://" + net.JoinHostPort(o.ServerHost, "6443")
	status, header, body, err := o.Get(base + "/cacerts")
	if err != nil || status != http.StatusOK {
		r.Errors = append(r.Errors, fmt.Sprintf("could not read the cluster CA at %s (HTTP %d)", o.ServerHost, status))
	} else {
		if !k3s.CAHashMatches(o.Token, body) {
			r.Errors = append(r.Errors, fmt.Sprintf("the join token does not belong to the cluster at %s (CA hash mismatch)", o.ServerHost))
		}
		if date := header.Get("Date"); date != "" {
			skew, err := ClockSkew(date, o.Now())
			if err != nil {
				r.Warnings = append(r.Warnings, "could not read the cluster clock")
			} else {
				abs := skew
				if abs < 0 {
					abs = -abs
				}
				// The Date header has one-second resolution plus request
				// latency, so only warn above 2s.
				message := fmt.Sprintf("cluster clock skew is %s; synchronise clocks with chrony/NTP", skew)
				if abs > 5*time.Second {
					r.Errors = append(r.Errors, message)
				} else if abs > 2*time.Second {
					r.Warnings = append(r.Warnings, message)
				}
			}
		}
	}
	status, _, body, err = o.Get(base + "/version")
	var version struct {
		GitVersion string `json:"gitVersion"`
	}
	if err != nil || status != http.StatusOK || json.Unmarshal(body, &version) != nil || version.GitVersion == "" {
		r.Warnings = append(r.Warnings, fmt.Sprintf("could not read the cluster's k3s version (HTTP %d); use the same platformctl release on every node", status))
	} else if version.GitVersion != o.LocalK3sVersion {
		r.Errors = append(r.Errors, fmt.Sprintf("the cluster runs k3s %s but this platformctl installs %s; use the same platformctl release on every node", version.GitVersion, o.LocalK3sVersion))
	}
	if synced, err := o.NTPSynced(); err != nil || !synced {
		r.Warnings = append(r.Warnings, "clock is not synchronised with chrony/NTP; etcd and TLS need synchronised clocks")
	}
	for _, port := range ports {
		if o.Role == "agent" && port == 6443 {
			continue
		}
		if o.PortInUse(port) {
			r.Errors = append(r.Errors, fmt.Sprintf("port %d is already in use on this node", port))
		}
	}
	r.Passed = len(r.Errors) == 0
	return r
}

func redactJoinError(err error, token string) string {
	if token == "" {
		return err.Error()
	}
	return strings.ReplaceAll(err.Error(), token, "[redacted]")
}
