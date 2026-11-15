package cmd

import (
	"net"
	"strings"
	"testing"
	"time"
)

// A joined node's kubelet starts only after k3s has imported the staged images;
// hardening must wait for it instead of probing once (real-server finding).
func TestWaitLocalPortWaitsForLateListener(t *testing.T) {
	probe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	_, port, _ := net.SplitHostPort(probe.Addr().String())
	probe.Close()

	opened := make(chan net.Listener, 1)
	go func() {
		time.Sleep(300 * time.Millisecond)
		l, err := net.Listen("tcp", "127.0.0.1:"+port)
		if err != nil {
			opened <- nil
			return
		}
		opened <- l
	}()
	start := time.Now()
	if err := waitLocalPort(port, 10*time.Second, 50*time.Millisecond); err != nil {
		t.Fatalf("waitLocalPort: %v", err)
	}
	if time.Since(start) < 250*time.Millisecond {
		t.Fatal("returned before the listener existed")
	}
	if l := <-opened; l != nil {
		l.Close()
	}
}

func TestWaitLocalPortTimesOut(t *testing.T) {
	probe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	_, port, _ := net.SplitHostPort(probe.Addr().String())
	probe.Close()
	err = waitLocalPort(port, 200*time.Millisecond, 50*time.Millisecond)
	if err == nil || !strings.Contains(err.Error(), "did not start listening on port "+port) {
		t.Fatalf("want a timeout error, got %v", err)
	}
}
