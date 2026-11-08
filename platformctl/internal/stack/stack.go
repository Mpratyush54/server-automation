// Package stack installs the platform stack: one OCI artifact on GHCR
// (ghcr.io/mpratyush54/platform-stack) with every third-party image, every
// pinned Helm chart and k3s, built by scripts/build-stack.sh.
//
// Installing it before k3s starts replaces ~30 separate image pulls from
// Docker Hub, quay.io and GHCR with one parallel download from our registry:
// k3s imports the image tarballs from its images directory at start-up, charts
// land in the chart cache, and the k3s binary + install script are staged for
// the k3s step. The stack is versioned independently of platformctl; the
// manifest digest each server installed is recorded in RecordPath.
package stack

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/ocifetch"
)

// Repo is the stack artifact repository.
const Repo = "ghcr.io/mpratyush54/platform-stack"

// DefaultChannel is installed when PLATFORM_STACK is unset.
const DefaultChannel = "stable"

// Paths where the stack's files go. Tests override them.
type Paths struct {
	// K3sImages is where k3s imports airgap image tarballs at start-up.
	K3sImages string
	// Charts is versions.ChartCacheDir.
	Charts string
	// Staging holds the k3s binary, its install script and stack.json.
	Staging string
	// Record is the JSON file recording the installed stack.
	Record string
}

// DefaultPaths are the production locations.
var DefaultPaths = Paths{
	K3sImages: "/var/lib/rancher/k3s/agent/images",
	Charts:    "/var/lib/platform/charts",
	Staging:   "/var/lib/platform/stack",
	Record:    "/var/lib/platform/stack/installed.json",
}

// K3sBinary and K3sScript are where the stack stages k3s for the k3s step.
func (p Paths) K3sBinary() string { return filepath.Join(p.Staging, "k3s") }
func (p Paths) K3sScript() string { return filepath.Join(p.Staging, "k3s-install.sh") }

// Tag returns the tag for a PLATFORM_STACK choice: "" or a channel name
// ("stable", "edge") → "<channel>-<arch>"; a version ("2026.11.08-3") →
// "<version>-<arch>". It returns "" for "off".
func Tag(choice, arch string) string {
	choice = strings.TrimSpace(choice)
	switch choice {
	case "off", "none", "false", "0":
		return ""
	case "":
		choice = DefaultChannel
	}
	return choice + "-" + arch
}

// Result describes an installed stack.
type Result struct {
	Tag      string    `json:"tag"`
	Digest   string    `json:"digest"`
	Version  string    `json:"stackVersion,omitempty"`
	Files    int       `json:"files"`
	Bytes    int64     `json:"bytes"`
	Seconds  float64   `json:"seconds"`
	Finished time.Time `json:"installedAt"`
}

// destination maps a stack file to its path and mode, or "" to skip it.
func destination(p Paths, name string) (string, os.FileMode) {
	switch {
	case name == "k3s":
		return p.K3sBinary(), 0o755
	case name == "k3s-install.sh":
		return p.K3sScript(), 0o700
	case name == "stack.json":
		return filepath.Join(p.Staging, "stack.json"), 0o644
	case strings.HasPrefix(name, "chart-") && strings.HasSuffix(name, ".tgz"):
		return filepath.Join(p.Charts, strings.TrimPrefix(name, "chart-")), 0o644
	case strings.HasSuffix(name, ".tar.zst") || strings.HasSuffix(name, ".tar"):
		return filepath.Join(p.K3sImages, name), 0o644
	}
	return "", 0
}

// Install downloads the stack tagged `tag` with up to `parallel` concurrent
// downloads and places every file. Each file is verified against its digest.
func Install(client *ocifetch.Client, tag string, p Paths, parallel int) (Result, error) {
	started := time.Now()
	repo := strings.TrimPrefix(Repo, "ghcr.io/")
	a, err := client.Resolve(repo, tag)
	if err != nil {
		return Result{}, fmt.Errorf("resolve %s:%s: %w", Repo, tag, err)
	}
	if len(a.Files) == 0 {
		return Result{}, fmt.Errorf("%s:%s has no files", Repo, tag)
	}
	for _, d := range []string{p.K3sImages, p.Charts, p.Staging} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return Result{}, err
		}
	}
	if parallel < 1 {
		parallel = 1
	}
	// Largest first, so the long downloads start immediately.
	files := append([]ocifetch.File(nil), a.Files...)
	sort.Slice(files, func(i, j int) bool { return files[i].Size > files[j].Size })

	var (
		wg    sync.WaitGroup
		mu    sync.Mutex
		errs  []string
		total int64
		sem   = make(chan struct{}, parallel)
	)
	for _, f := range files {
		dst, perm := destination(p, f.Name)
		if dst == "" {
			continue
		}
		wg.Add(1)
		go func(f ocifetch.File, dst string, perm os.FileMode) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			if err := client.Download(a, f, dst, perm); err != nil {
				mu.Lock()
				errs = append(errs, fmt.Sprintf("%s: %v", f.Name, err))
				mu.Unlock()
				return
			}
			mu.Lock()
			total += f.Size
			mu.Unlock()
		}(f, dst, perm)
	}
	wg.Wait()
	if len(errs) > 0 {
		sort.Strings(errs)
		return Result{}, fmt.Errorf("stack download failed: %s", strings.Join(errs, "; "))
	}

	res := Result{Tag: tag, Digest: a.Digest, Files: len(files), Bytes: total,
		Seconds: time.Since(started).Seconds(), Finished: time.Now().UTC()}
	if data, err := os.ReadFile(filepath.Join(p.Staging, "stack.json")); err == nil {
		var meta struct {
			StackVersion string `json:"stackVersion"`
		}
		if json.Unmarshal(data, &meta) == nil {
			res.Version = meta.StackVersion
		}
	}
	if data, err := json.MarshalIndent(res, "", "  "); err == nil {
		_ = os.WriteFile(p.Record, append(data, '\n'), 0o644)
	}
	return res, nil
}

// Staged reports whether the stack staged a k3s binary and install script.
func (p Paths) Staged() bool {
	for _, f := range []string{p.K3sBinary(), p.K3sScript()} {
		if fi, err := os.Stat(f); err != nil || fi.Size() == 0 {
			return false
		}
	}
	return true
}
