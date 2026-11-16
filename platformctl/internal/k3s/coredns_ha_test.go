package k3s

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestCoreDNSReplicas(t *testing.T) {
	for ready, want := range map[int]int{-1: 1, 0: 1, 1: 1, 2: 2, 3: 3, 5: 3} {
		if got := CoreDNSReplicas(ready); got != want {
			t.Errorf("CoreDNSReplicas(%d) = %d, want %d", ready, got, want)
		}
	}
}

// fakeKubectl lists the given node lines, reports cur CoreDNS replicas and
// records `scale` calls.
func fakeKubectl(t *testing.T, nodes []string, cur string) (dir, log string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("needs bash")
	}
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skip("needs bash")
	}
	dir = t.TempDir()
	log = filepath.Join(dir, "scale.log")
	script := `#!/bin/bash
case " $* " in
  *" get node srv2 "*) echo True ;;
  *" get nodes --no-headers "*) printf '%s\n' ` + shellQuote(strings.Join(nodes, "\n")) + ` ;;
  *" get deploy coredns "*) echo ` + cur + ` ;;
  *" scale "*) echo "$*" >> "` + log + `" ;;
esac
exit 0
`
	if err := os.WriteFile(filepath.Join(dir, "kubectl"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return dir, log
}

func TestCoreDNSScaleScript(t *testing.T) {
	ready := func(n string) string { return n + "   Ready   control-plane,etcd   1m   v1" }
	cases := []struct {
		name  string
		nodes []string
		cur   string
		want  string // expected --replicas, "" = no scale call
	}{
		{"second server", []string{ready("srv1"), ready("srv2")}, "1", "--replicas=2"},
		{"third server", []string{ready("srv1"), ready("srv2"), ready("srv3")}, "2", "--replicas=3"},
		{"capped", []string{ready("a"), ready("b"), ready("c"), ready("d")}, "1", "--replicas=3"},
		{"NotReady not counted", []string{ready("srv1"), "srv3   NotReady   control-plane,etcd   1m   v1", ready("srv2")}, "1", "--replicas=2"},
		{"never scales down", []string{ready("srv1"), ready("srv2")}, "3", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir, log := fakeKubectl(t, tc.nodes, tc.cur)
			cmd := exec.Command("bash", "-c", coreDNSScaleScript("srv2"))
			cmd.Env = append(os.Environ(), "PATH="+dir+":"+os.Getenv("PATH"))
			if out, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("script failed: %v\n%s", err, out)
			}
			b, _ := os.ReadFile(log)
			got := strings.TrimSpace(string(b))
			if tc.want == "" {
				if got != "" {
					t.Fatalf("unexpected scale: %s", got)
				}
				return
			}
			if !strings.Contains(got, "-n kube-system scale deploy coredns "+tc.want) {
				t.Fatalf("scale call %q, want %s", got, tc.want)
			}
		})
	}
}
