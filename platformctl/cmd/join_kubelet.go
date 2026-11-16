package cmd

import (
	"fmt"
	"net"
	"time"

	"github.com/fatih/color"
)

// kubeletWaitTimeout bounds the wait for the local kubelet after a join. k3s
// imports every image tarball in /var/lib/rancher/k3s/agent/images (the
// platform stack or the offline bundle, several GiB) before it starts the
// kubelet, which can take many minutes on a small disk.
const kubeletWaitTimeout = 30 * time.Minute

// joinWaitKubelet runs before host hardening on a joined node: the firewall
// confirmation probes the kubelet port once, so it must already be serving.
// Swapped in tests.
var joinWaitKubelet = func() error { return waitLocalPort("10250", kubeletWaitTimeout, 2*time.Second) }

// waitLocalPort waits until 127.0.0.1:port accepts TCP connections.
func waitLocalPort(port string, timeout, interval time.Duration) error {
	addr := net.JoinHostPort("127.0.0.1", port)
	deadline := time.Now().Add(timeout)
	announced := false
	for {
		c, err := net.DialTimeout("tcp", addr, 3*time.Second)
		if err == nil {
			_ = c.Close()
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("the kubelet did not start listening on port %s within %s (check: journalctl -u k3s -u k3s-agent)", port, timeout)
		}
		if !announced {
			color.Cyan("  ■ Waiting for the kubelet (k3s imports the staged images first)...")
			announced = true
		}
		time.Sleep(interval)
	}
}
