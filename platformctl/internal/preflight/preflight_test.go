package preflight

import "testing"

func TestPortOwnedByPlatform(t *testing.T) {
	cases := []struct {
		name string
		out  string
		port int
		want bool
	}{
		{"k3s api", "LISTEN 0 4096 *:6443 users:((\"k3s-server\",pid=123,fd=10))", 6443, true},
		{"nginx ingress", "LISTEN 0 511 *:80 users:((\"nginx\",pid=99,fd=6))", 80, true},
		{"random app", "LISTEN 0 128 *:80 users:((\"python3\",pid=50,fd=3))", 80, false},
		{"empty", "", 80, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := portOwnedByPlatform(tc.out, tc.port)
			if got != tc.want {
				t.Fatalf("portOwnedByPlatform(%q, %d)=%v want %v", tc.out, tc.port, got, tc.want)
			}
		})
	}
}
