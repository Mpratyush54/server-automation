package cmd

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"

	"github.com/fatih/color"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/apt"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/ocifetch"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/stack"
)

// Swapped in tests. Everything here finishes before k3sJoin: k3s imports the
// image tarballs in its images directory only when it starts.
var (
	joinStageBundle     = prepareJoinBundle
	joinOfflinePackages = func() error { return apt.InstallOfflinePackages(joinPackageRoot(stack.DefaultPaths)) }
	joinStackPaths      = stack.DefaultPaths
	joinInstallBundle   = installBundle
	// After k3sJoin: gives the digest-pinned images k3s imported their digest names.
	joinNameBundleImages = nameBundleImages
)

// joinPackageRoot holds the bundle's packages/ubuntu-<release>/<arch>/*.deb.
func joinPackageRoot(p stack.Paths) string { return filepath.Join(p.Staging, "packages") }

// prepareJoinBundle installs the offline bundle (--bundle) or, without one,
// the platform stack (PLATFORM_STACK, default stable) before k3s starts.
//
// A bundle join is offline: the bundle must carry the k3s binary, its
// installer and node packages for this architecture, and k3s is then
// installed from them with no download fallback (k3s.ServerOptions.Offline).
// Images land in the k3s images directory, where k3s imports them at start.
func prepareJoinBundle(bundlePath string) error {
	if bundlePath != "" {
		if err := joinInstallBundle(bundlePath); err != nil {
			return err
		}
		return checkJoinBundle(joinStackPaths, runtime.GOARCH)
	}
	tag := stack.Tag(os.Getenv("PLATFORM_STACK"), runtime.GOARCH)
	if tag == "" || joinK3sInstalled() {
		return nil
	}
	// Online join: one parallel download from GHCR instead of image pulls once
	// pods start. Not fatal, as on provision: k3s and images then download
	// individually.
	color.Cyan("  ■ Downloading the platform stack %s:%s...", stack.Repo, tag)
	paths := joinStackPaths
	dl := stack.Start(ocifetch.New("ghcr.io"), tag, paths, stackParallel)
	for range dl.Images {
	}
	if _, err := dl.Wait(); err != nil {
		color.Yellow("  ⚠ platform stack unavailable (%v); k3s and images will be downloaded individually", err)
	}
	return stageJoinImages(paths)
}

// checkJoinBundle refuses a bundle that cannot complete an offline join on
// this node: an older bundle without k3s or packages, or another architecture.
func checkJoinBundle(p stack.Paths, goarch string) error {
	if !p.Staged() {
		return fmt.Errorf("the bundle lacks the k3s binary or installer; use a bundle from a release with offline join support")
	}
	repos, err := filepath.Glob(filepath.Join(joinPackageRoot(p), "ubuntu-*", goarch, "Packages"))
	if err != nil {
		return err
	}
	if len(repos) == 0 {
		return fmt.Errorf("the bundle has no node packages for %s; use the %s bundle from a release with offline join support", goarch, goarch)
	}
	return nil
}

// stageJoinImages moves the stack's platform image tarballs into the k3s
// images directory, so k3s imports them when it first starts on this node.
func stageJoinImages(paths stack.Paths) error {
	files, err := filepath.Glob(filepath.Join(paths.ImagesDir(), "*.tar*"))
	if err != nil {
		return err
	}
	if len(files) == 0 {
		return nil
	}
	if err := os.MkdirAll(paths.K3sImages, 0o755); err != nil {
		return err
	}
	for _, file := range files {
		if err := os.Rename(file, filepath.Join(paths.K3sImages, filepath.Base(file))); err != nil {
			return err
		}
	}
	return nil
}
