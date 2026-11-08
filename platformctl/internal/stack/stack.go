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
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/klauspost/compress/zstd"

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

// ImagesDir holds the platform image tarballs until ImportImages loads them.
func (p Paths) ImagesDir() string { return filepath.Join(p.Staging, "images") }

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
	case strings.HasPrefix(name, "k3s-airgap-images-"):
		// k3s's own images (pause, coredns, ...): imported by k3s at start-up.
		return filepath.Join(p.K3sImages, name), 0o644
	case strings.HasSuffix(name, ".tar.zst") || strings.HasSuffix(name, ".tar"):
		// Platform images: imported in parallel once k3s runs (ImportImages).
		// In K3sImages, k3s would import them one by one before reporting
		// ready, which took ~1.5 minutes for 2 GB.
		return filepath.Join(p.ImagesDir(), name), 0o644
	}
	return "", 0
}

// Download is a stack download in progress (see Start).
type Download struct {
	// Base delivers one value once every file except the platform images
	// (k3s binary + install script + airgap images, charts, stack.json) is in
	// place: nil, or the error. The k3s step can start then.
	Base <-chan error
	// Images delivers the path of each platform image tarball as soon as it
	// is downloaded and verified, so it can be imported while the rest are
	// still downloading. Closed when no more will come.
	Images <-chan string
	done   chan struct{}
	res    Result
	err    error
}

// Wait blocks until every download finished and returns the summary.
func (d *Download) Wait() (Result, error) {
	<-d.done
	return d.res, d.err
}

// Start downloads the stack tagged `tag` in the background, `parallel` files
// at a time, base files first. Every file is verified against its digest.
func Start(client *ocifetch.Client, tag string, p Paths, parallel int) *Download {
	base := make(chan error, 1)
	d := &Download{Base: base, done: make(chan struct{})}
	finish := func(res Result, err error) {
		d.res, d.err = res, err
		close(d.done)
	}

	started := time.Now()
	repo := strings.TrimPrefix(Repo, "ghcr.io/")
	a, err := client.Resolve(repo, tag)
	if err == nil && len(a.Files) == 0 {
		err = fmt.Errorf("has no files")
	}
	if err == nil {
		for _, dir := range []string{p.K3sImages, p.Charts, p.Staging, p.ImagesDir()} {
			if err = os.MkdirAll(dir, 0o755); err != nil {
				break
			}
		}
	}
	if err != nil {
		err = fmt.Errorf("resolve %s:%s: %w", Repo, tag, err)
		images := make(chan string)
		close(images)
		d.Images = images
		base <- err
		finish(Result{}, err)
		return d
	}
	if parallel < 1 {
		parallel = 1
	}

	var baseFiles, imageFiles []ocifetch.File
	for _, f := range a.Files {
		switch dst, _ := destination(p, f.Name); {
		case dst == "":
		case filepath.Dir(dst) == p.ImagesDir():
			imageFiles = append(imageFiles, f)
		default:
			baseFiles = append(baseFiles, f)
		}
	}
	// Base files are queued first; within each group the largest start first.
	bySize := func(fs []ocifetch.File) {
		sort.Slice(fs, func(i, j int) bool { return fs[i].Size > fs[j].Size })
	}
	bySize(baseFiles)
	bySize(imageFiles)
	images := make(chan string, len(imageFiles))
	d.Images = images

	var (
		mu    sync.Mutex
		errs  []string
		total int64
		sem   = make(chan struct{}, parallel)
	)
	get := func(f ocifetch.File) (string, bool) {
		dst, perm := destination(p, f.Name)
		if err := client.Download(a, f, dst, perm); err != nil {
			mu.Lock()
			errs = append(errs, fmt.Sprintf("%s: %v", f.Name, err))
			mu.Unlock()
			return "", false
		}
		mu.Lock()
		total += f.Size
		mu.Unlock()
		return dst, true
	}
	run := func(fs []ocifetch.File, wg *sync.WaitGroup, onDone func(string)) {
		for _, f := range fs {
			wg.Add(1)
			sem <- struct{}{} // acquire in queue order: base files go first
			go func(f ocifetch.File) {
				defer wg.Done()
				defer func() { <-sem }()
				if dst, ok := get(f); ok && onDone != nil {
					onDone(dst)
				}
			}(f)
		}
	}

	go func() {
		var baseWG, imageWG sync.WaitGroup
		go func() {
			baseWG.Wait()
			mu.Lock()
			var berr error
			if len(errs) > 0 {
				berr = fmt.Errorf("stack download failed: %s", strings.Join(errs, "; "))
			}
			mu.Unlock()
			base <- berr
		}()
		// Base files download alone so k3s can start as early as possible;
		// sharing bandwidth with the images delayed k3s by ~15 s.
		run(baseFiles, &baseWG, nil)
		baseWG.Wait()
		run(imageFiles, &imageWG, func(path string) { images <- path })
		imageWG.Wait()
		close(images)

		if len(errs) > 0 {
			sort.Strings(errs)
			finish(Result{}, fmt.Errorf("stack download failed: %s", strings.Join(errs, "; ")))
			return
		}
		res := Result{Tag: tag, Digest: a.Digest, Files: len(baseFiles) + len(imageFiles), Bytes: total,
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
		finish(res, nil)
	}()
	return d
}

// Install downloads the whole stack and waits for it (Start, then Wait).
func Install(client *ocifetch.Client, tag string, p Paths, parallel int) (Result, error) {
	d := Start(client, tag, p, parallel)
	for range d.Images {
	}
	return d.Wait()
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

// importFn loads one image tarball into containerd; swapped in tests.
var importFn = importTarball

// ImportImages loads the staged platform image tarballs into k3s' containerd,
// `parallel` at a time, and deletes each tarball once imported. Call it after
// k3s is running and before workloads start, so no pod pulls from a registry.
func ImportImages(p Paths, parallel int) (int, error) {
	files, _ := filepath.Glob(filepath.Join(p.ImagesDir(), "*.tar*"))
	if len(files) == 0 {
		return 0, nil
	}
	if parallel < 1 {
		parallel = 1
	}
	var (
		wg   sync.WaitGroup
		mu   sync.Mutex
		errs []string
		sem  = make(chan struct{}, parallel)
	)
	for _, f := range files {
		wg.Add(1)
		go func(f string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			if err := importFn(f); err != nil {
				mu.Lock()
				errs = append(errs, fmt.Sprintf("%s: %v", filepath.Base(f), err))
				mu.Unlock()
				return
			}
			_ = os.Remove(f)
		}(f)
	}
	wg.Wait()
	if len(errs) > 0 {
		sort.Strings(errs)
		return len(files) - len(errs), fmt.Errorf("image import failed: %s", strings.Join(errs, "; "))
	}
	return len(files), nil
}

// ImportFrom imports image tarballs as they arrive on `in` (Download.Images),
// `parallel` at a time, deleting each once imported. It returns when `in` is
// closed and every import finished, so imports overlap the downloads.
func ImportFrom(in <-chan string, parallel int) (int, error) {
	if parallel < 1 {
		parallel = 1
	}
	var (
		wg   sync.WaitGroup
		mu   sync.Mutex
		errs []string
		ok   int
	)
	for w := 0; w < parallel; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for f := range in {
				if err := importFn(f); err != nil {
					mu.Lock()
					errs = append(errs, fmt.Sprintf("%s: %v", filepath.Base(f), err))
					mu.Unlock()
					continue
				}
				_ = os.Remove(f)
				mu.Lock()
				ok++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if len(errs) > 0 {
		sort.Strings(errs)
		return ok, fmt.Errorf("image import failed: %s", strings.Join(errs, "; "))
	}
	return ok, nil
}

// importTarball streams a (zstd-compressed) `docker save` tarball into
// `k3s ctr -n k8s.io images import -`, the namespace the kubelet uses.
func importTarball(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	var r io.Reader = f
	if strings.HasSuffix(path, ".zst") {
		dec, err := zstd.NewReader(f)
		if err != nil {
			return err
		}
		defer dec.Close()
		r = dec
	}
	// --no-unpack: store the image content only. The CRI plugin unpacks an
	// image when its first container is created, so unpacking spreads over the
	// parallel pod starts instead of blocking the install (writing every image
	// twice up front took ~2 minutes on a 125 MB/s disk).
	cmd := exec.Command("k3s", "ctr", "-n", "k8s.io", "images", "import", "--no-unpack", "-")
	cmd.Stdin = r
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("%v: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}
