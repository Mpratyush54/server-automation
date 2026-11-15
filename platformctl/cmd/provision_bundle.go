package cmd

import (
	"context"
	"os"
	"path/filepath"

	"github.com/fatih/color"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/apt"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/helm"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/images"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/stack"
)

// Swapped in tests.
var (
	provisionStackPaths     = stack.DefaultPaths
	provisionPrereqsOnline  = apt.InstallPrereqs
	provisionPrereqsOffline = apt.InstallPrereqsFromBundle
	provisionHelmOnline     = helm.Install
	provisionHelmOffline    = helm.InstallFrom
	provisionNameImages     = nameBundleImages
)

// hostSources says where provision takes the host software from. The zero
// value is the online install: apt mirrors, get.helm.sh, and k3s from the
// platform stack with the download as fallback.
type hostSources struct {
	packages string // bundle package root (packages/ubuntu-<release>/<arch>); "" = apt mirrors
	helm     string // the bundle's Helm binary; "" = download from get.helm.sh
	k3s      bool   // the bundle's staged k3s only, with no download fallback
}

// bundleSources reports what the installed offline bundle provides for this
// architecture. A bundle from an older release may lack some of it; those
// parts are downloaded as before (see warnMissing).
func bundleSources(p stack.Paths, goarch string) hostSources {
	var s hostSources
	if repos, _ := filepath.Glob(filepath.Join(joinPackageRoot(p), "ubuntu-*", goarch, "Packages")); len(repos) > 0 {
		s.packages = joinPackageRoot(p)
	}
	if fi, err := os.Stat(p.HelmBinary()); err == nil && fi.Mode().IsRegular() {
		s.helm = p.HelmBinary()
	}
	s.k3s = p.Staged()
	return s
}

// warnMissing names what an older bundle lacks: provision then needs the
// internet for it.
func (s hostSources) warnMissing() {
	if s.packages == "" {
		color.Yellow("  ⚠ the bundle has no node packages for this architecture; prerequisites are installed from the apt mirrors")
	}
	if s.helm == "" {
		color.Yellow("  ⚠ the bundle has no Helm binary; Helm is downloaded from get.helm.sh")
	}
	if !s.k3s {
		color.Yellow("  ⚠ the bundle has no k3s binary; k3s is downloaded")
	}
}

// installPrereqs installs the system prerequisites from the bundle's package
// repositories (the same offline apt source as `join --bundle`) or, without
// a bundle, from the apt mirrors.
func installPrereqs(s hostSources) error {
	if s.packages != "" {
		return provisionPrereqsOffline(s.packages)
	}
	return provisionPrereqsOnline()
}

// installHelm installs the bundle's Helm binary or downloads the release.
func installHelm(s hostSources) error {
	if s.helm != "" {
		return provisionHelmOffline(s.helm)
	}
	return provisionHelmOnline()
}

// nameBundleImages makes the digest-pinned images of the bundle resolvable by
// digest once k3s has imported its archives (see images.AliasDigestRefs).
// Used by `provision --bundle` and `join --bundle`.
func nameBundleImages() error {
	res, err := images.AliasDigestRefs(context.Background(), images.DigestPinned())
	if err != nil {
		return err
	}
	for _, img := range res.Missing {
		color.Yellow("  ⚠ %s is not in the bundle; the node pulls it from its registry", img)
	}
	if len(res.Named) > 0 {
		color.Green("  ✓ %d digest-pinned image(s) resolve from the bundle", len(res.Named))
	}
	return nil
}
