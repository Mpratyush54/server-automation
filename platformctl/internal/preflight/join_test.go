package preflight

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"net"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestCheckJoin(t *testing.T) {
	for _, tc := range []struct {
		name                   string
		role                   string
		unreachable            int
		ca, version            string
		status                 int
		skew                   time.Duration
		ntp                    bool
		busy                   int
		wantError, wantWarning string
	}{
		{name: "all good", ntp: true},
		{name: "unreachable", unreachable: 2379, ntp: true, wantError: "PLATFORM_CLUSTER_NODES"},
		{name: "CA mismatch", ca: "other", ntp: true, wantError: "CA hash mismatch"},
		{name: "version mismatch", version: "v2", ntp: true, wantError: "cluster runs k3s v2"},
		{name: "version denied", status: 401, ntp: true, wantWarning: "HTTP 401"},
		{name: "skew error", skew: 6 * time.Second, ntp: true, wantError: "clock skew is 6s"},
		{name: "negative skew", skew: -6 * time.Second, ntp: true, wantError: "clock skew is -6s"},
		{name: "skew warning", skew: 3 * time.Second, ntp: true, wantWarning: "clock skew is 3s"},
		{name: "skew within HTTP Date resolution", skew: 2 * time.Second, ntp: true},
		{name: "NTP warning", wantWarning: "chrony/NTP"},
		{name: "busy server", busy: 2379, ntp: true, wantError: "port 2379 is already in use on this node"},
		{name: "agent", role: "agent", ntp: true},
		{name: "busy agent", role: "agent", ntp: true, busy: 10250, wantError: "port 10250"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			role := tc.role
			if role == "" {
				role = "server"
			}
			now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
			sum := sha256.Sum256([]byte("ca"))
			token := fmt.Sprintf("K10%x::server:secret", sum)
			var dialed, local []int
			o := JoinOptions{ServerHost: "2001:db8::1", Role: role, Token: token, LocalK3sVersion: "v1", Now: func() time.Time { return now }, NTPSynced: func() (bool, error) { return tc.ntp, nil }}
			o.Dial = func(network, address string, timeout time.Duration) (net.Conn, error) {
				if network != "tcp" || timeout != 5*time.Second {
					t.Fatal(network, timeout)
				}
				host, port, err := net.SplitHostPort(address)
				if err != nil || host != "2001:db8::1" {
					t.Fatal(address, err)
				}
				var n int
				fmt.Sscan(port, &n)
				dialed = append(dialed, n)
				if n == tc.unreachable {
					return nil, errors.New("blocked")
				}
				return nil, nil
			}
			o.PortInUse = func(port int) bool { local = append(local, port); return port == tc.busy }
			o.Get = func(url string) (int, http.Header, []byte, error) {
				if url == "https://[2001:db8::1]:6443/cacerts" {
					ca := tc.ca
					if ca == "" {
						ca = "ca"
					}
					return 200, http.Header{"Date": []string{now.Add(tc.skew).Format(http.TimeFormat)}}, []byte(ca), nil
				}
				if url != "https://[2001:db8::1]:6443/version" {
					t.Fatal(url)
				}
				status := tc.status
				if status == 0 {
					status = 200
				}
				version := tc.version
				if version == "" {
					version = "v1"
				}
				return status, nil, []byte(fmt.Sprintf(`{"gitVersion":%q}`, version)), nil
			}
			r := CheckJoin(o)
			if r.Passed != (tc.wantError == "") {
				t.Fatal(r)
			}
			if tc.wantError != "" && !strings.Contains(strings.Join(r.Errors, "\n"), tc.wantError) {
				t.Fatal(r.Errors)
			}
			if tc.wantWarning != "" {
				if !strings.Contains(strings.Join(r.Warnings, "\n"), tc.wantWarning) {
					t.Fatal(r.Warnings)
				}
			} else if len(r.Warnings) != 0 {
				t.Fatal(r.Warnings)
			}
			if strings.Contains(strings.Join(r.Errors, "\n"), token) {
				t.Fatal("leaked token")
			}
			if !reflect.DeepEqual(dialed, ClusterPorts(role)) {
				t.Fatal(dialed)
			}
			wantLocal := ClusterPorts(role)
			if role == "agent" {
				wantLocal = []int{10250}
			}
			if !reflect.DeepEqual(local, wantLocal) {
				t.Fatal(local)
			}
		})
	}
}

func TestJoinDiscoveryFailures(t *testing.T) {
	for _, failure := range []string{"CA request", "CA status", "version request", "version JSON", "NTP error"} {
		t.Run(failure, func(t *testing.T) {
			o := JoinOptions{ServerHost: "node", Role: "agent", Token: "short", LocalK3sVersion: "v1", Dial: func(string, string, time.Duration) (net.Conn, error) { return nil, nil }, PortInUse: func(int) bool { return false }, NTPSynced: func() (bool, error) {
				if failure == "NTP error" {
					return false, errors.New("unavailable")
				}
				return true, nil
			}}
			o.Get = func(url string) (int, http.Header, []byte, error) {
				if strings.HasSuffix(url, "/cacerts") {
					if failure == "CA request" {
						return 0, nil, nil, errors.New("failed")
					}
					if failure == "CA status" {
						return 503, nil, nil, nil
					}
					return 200, nil, []byte("ca"), nil
				}
				if failure == "version request" {
					return 0, nil, nil, errors.New("failed")
				}
				if failure == "version JSON" {
					return 200, nil, []byte("broken"), nil
				}
				return 200, nil, []byte(`{"gitVersion":"v1"}`), nil
			}
			r := CheckJoin(o)
			if strings.HasPrefix(failure, "CA") {
				if r.Passed || len(r.Errors) == 0 {
					t.Fatal(r)
				}
			} else if !r.Passed || len(r.Warnings) == 0 {
				t.Fatal(r)
			}
		})
	}
}

func TestClockSkew(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	if skew, err := ClockSkew(now.Add(-2*time.Second).Format(http.TimeFormat), now); err != nil || skew != -2*time.Second {
		t.Fatal(skew, err)
	}
	if _, err := ClockSkew("bad", now); err == nil {
		t.Fatal("invalid date")
	}
	if len(ClusterPorts("unknown")) != 0 {
		t.Fatal("unknown role")
	}
}

func TestCheckJoinViaAPIVIPSkipsEtcdDial(t *testing.T) {
	var dialled []string
	r := CheckJoin(JoinOptions{
		ServerHost: "10.0.0.60", Role: "server", Token: "K10x::server:y", LocalK3sVersion: "v1",
		ViaAPIVIP: true,
		Dial: func(network, addr string, timeout time.Duration) (net.Conn, error) {
			dialled = append(dialled, addr)
			return nil, nil
		},
		Get:       func(string) (int, http.Header, []byte, error) { return 0, nil, nil, errors.New("offline") },
		NTPSynced: func() (bool, error) { return true, nil },
		PortInUse: func(int) bool { return false },
	})
	for _, a := range dialled {
		if strings.HasSuffix(a, ":2379") || strings.HasSuffix(a, ":2380") {
			t.Fatalf("etcd port dialled through the VIP: %v", dialled)
		}
	}
	if len(dialled) != 2 {
		t.Fatalf("want 6443 and 10250 dialled, got %v", dialled)
	}
	found := false
	for _, w := range r.Warnings {
		if strings.Contains(w, "API VIP") {
			found = true
		}
	}
	if !found {
		t.Fatalf("missing VIP warning: %v", r.Warnings)
	}
}
