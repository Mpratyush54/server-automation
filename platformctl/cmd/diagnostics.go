package cmd

import (
	"context"
	"fmt"
	"io"
	"os"
	"runtime"
	"strings"
	"time"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/components"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/diagnostics"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/license"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/shell"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/state"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/versions"
)

// Seams for tests.
var (
	diagOut        io.Writer = os.Stdout
	diagPinned               = versions.LicenseClientPinned
	diagDeadline             = 45 * time.Second
	diagComponents           = func() []diagnostics.Component {
		var out []diagnostics.Component
		for _, c := range components.HealthStatus() {
			status := diagnostics.ComponentHealthy
			if !c.Healthy {
				status = diagnostics.ComponentDown
			}
			out = append(out, diagnostics.Component{Name: c.Name, Status: status})
		}
		return out
	}
	diagKubernetes = func() string {
		out, err := shell.Output("k3s", "--version")
		if f := strings.Fields(out); err == nil && len(f) >= 3 {
			return f[2]
		}
		return versions.K3sVersion
	}
	diagVersion   = func() string { return Version }
	diagArch      = func() string { return runtime.GOARCH }
	diagNow       = time.Now
	diagOSRelease = func() string { return diagnostics.OSRelease("/etc/os-release") }
	diagUptime    = func() int64 { return diagnostics.Uptime("/proc/uptime") }
)

func buildDiagnostics(operation string, err error) diagnostics.Payload {
	p := diagnostics.Payload{
		Schema:      diagnostics.Schema,
		Kind:        operation,
		GeneratedAt: diagNow().UTC().Format(time.RFC3339),
		Platform: diagnostics.Platform{
			Version:    diagVersion(),
			Profile:    cfg.Profile,
			NodeCount:  licenseNodeCount(),
			Arch:       diagArch(),
			OSRelease:  diagOSRelease(),
			K8sVersion: diagKubernetes(),
		},
		UptimeSeconds: diagUptime(),
		Steps:         diagnostics.StepsFrom(state.Timings()),
		Failures:      diagnostics.FailuresFrom(state.Timings(), operation, err),
		Components:    []diagnostics.Component{},
	}
	if err != nil {
		p.Kind, p.Operation = diagnostics.KindError, operation
	}
	if joinedRole() != "agent" {
		if c := diagComponents(); c != nil {
			p.Components = c
		}
	}
	return p
}

// sendDiagnostics never fails or blocks the command for long.
func sendDiagnostics(operation string, cmdErr error) {
	if !cfg.Diagnostics || isChild() || !diagnostics.IsSemver(diagVersion()) {
		return
	}
	if a := diagArch(); a != "amd64" && a != "arm64" {
		return
	}
	in := licenseInstaller()
	if !diagPinned() && in.Override == "" {
		return
	}
	path, ok := in.Locate()
	if !ok {
		return
	}
	fmt.Fprintln(diagOut, "  · Sending anonymous diagnostics to Cairn (set PLATFORM_DIAGNOSTICS=off to stop).")
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer func() { _ = recover() }()
		c := &license.Client{Path: path, Run: licenseRunner}
		if err := diagnostics.Send(context.Background(), buildDiagnostics(operation, cmdErr), c.SendReport); err != nil && os.Getenv("PLATFORMCTL_DEBUG") == "1" {
			fmt.Fprintf(os.Stderr, "debug: diagnostics not sent: %v\n", err)
		}
	}()
	select {
	case <-done:
	case <-time.After(diagDeadline):
	}
}
