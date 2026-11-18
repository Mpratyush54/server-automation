package cmd

import (
	"bytes"
	"errors"
	"io"
	"strings"
	"testing"
)

func stubUpdate(t *testing.T, role string, installed bool, refresh func() (bool, error)) *int {
	t.Helper()
	oldRole, oldInstalled, oldRefresh, oldImages, oldGate := joinedRole, clusterInstalled, refreshKubeVIP, updateImages, licenseGate
	t.Cleanup(func() {
		joinedRole, clusterInstalled, refreshKubeVIP, updateImages, licenseGate = oldRole, oldInstalled, oldRefresh, oldImages, oldGate
	})
	licenseGate = func(io.Writer) error { return nil }
	rolled := 0
	joinedRole = func() string { return role }
	clusterInstalled = func() bool { return installed }
	refreshKubeVIP = refresh
	updateImages = func() error { rolled++; return nil }
	return &rolled
}

func TestUpdateRefreshesKubeVIPThenRollsImages(t *testing.T) {
	refreshed := 0
	rolled := stubUpdate(t, "", true, func() (bool, error) { refreshed++; return true, nil })
	var out bytes.Buffer
	if err := runUpdate(&out); err != nil {
		t.Fatal(err)
	}
	if refreshed != 1 || *rolled != 1 {
		t.Fatalf("refreshed=%d rolled=%d", refreshed, *rolled)
	}
	if !strings.Contains(out.String(), "Refreshed this server's kube-vip manifest") {
		t.Fatalf("output: %q", out.String())
	}
}

func TestUpdateOnJoinedServerOnlyRefreshesLocalFiles(t *testing.T) {
	refreshed := 0
	rolled := stubUpdate(t, "server", false, func() (bool, error) { refreshed++; return false, nil })
	var out bytes.Buffer
	if err := runUpdate(&out); err != nil {
		t.Fatal(err)
	}
	// A joined server's .env lacks the cluster's image tag: rolling from here
	// could move the API to another release.
	if refreshed != 1 || *rolled != 0 {
		t.Fatalf("refreshed=%d rolled=%d", refreshed, *rolled)
	}
	if !strings.Contains(out.String(), "on the first server") {
		t.Fatalf("output: %q", out.String())
	}
}

func TestUpdateKubeVIPRefreshFailureIsNotFatal(t *testing.T) {
	rolled := stubUpdate(t, "", true, func() (bool, error) { return false, errors.New("invalid VIP interface name") })
	var out bytes.Buffer
	if err := runUpdate(&out); err != nil {
		t.Fatal(err)
	}
	if *rolled != 1 || !strings.Contains(out.String(), "WARNING: could not refresh") {
		t.Fatalf("rolled=%d out=%q", *rolled, out.String())
	}
}
