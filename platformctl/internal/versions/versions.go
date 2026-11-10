// Package versions is the single source of truth for every pinned version the
// installer uses: k3s, Helm and each Helm chart.
//
// Pinning makes installs reproducible, lets CI compute the exact image list
// (Phase 2 pre-pull) and lets the offline bundle (Phase 4) ship chart tarballs.
// Bump versions here only; `platformctl charts --json` exposes this table to
// scripts and CI.
package versions

import (
	"fmt"
	"os"
	"path"
	"path/filepath"
	"sort"
)

// K3sVersion is passed to get.k3s.io as INSTALL_K3S_VERSION.
const K3sVersion = "v1.37.2+k3s1"

// Mirrors on GHCR, published by .github/workflows/mirror-artifacts.yml. They
// are the fallback when an upstream download fails, e.g. during a GitHub
// Releases outage (charts and k3s are served from GitHub Releases, GHCR is a
// separate service). Anonymous pulls; content is addressed by digest.
const (
	// ChartMirror holds every pinned chart as <ChartMirror>/<BaseName>:<version>.
	ChartMirror = "oci://ghcr.io/mpratyush54/charts"
	// K3sMirror holds the k3s binaries and install script, tagged MirrorTag(K3sVersion).
	K3sMirror = "ghcr.io/mpratyush54/k3s"
)

// MirrorTag converts a version to a valid OCI tag ("+" is not allowed).
func MirrorTag(version string) string {
	out := []rune(version)
	for i, r := range out {
		if r == '+' {
			out[i] = '-'
		}
	}
	return string(out)
}

// HelmVersion is the Helm 3 release downloaded from get.helm.sh.
// Helm 4 changed flag semantics; stay on 3.x until the installer is validated on 4.
const HelmVersion = "v3.22.1"

// ChartCacheDir holds pre-downloaded chart tarballs (<name>-<version>.tgz).
// The offline bundle extracts charts here; Prefetch() also fills it.
const ChartCacheDir = "/var/lib/platform/charts"

// Chart describes one pinned Helm chart.
type Chart struct {
	// Name is the platformctl component key (also used for the cache file name).
	Name string `json:"name"`
	// Repo is the Helm repo alias (empty for OCI charts).
	Repo string `json:"repo,omitempty"`
	// RepoURL is the classic Helm repo URL (empty for OCI charts).
	RepoURL string `json:"repoUrl,omitempty"`
	// Chart is the chart name inside the repo, or the full oci:// reference.
	Chart string `json:"chart"`
	// Version is the exact chart version.
	Version string `json:"version"`
}

// IsOCI reports whether the chart is pulled from an OCI registry.
func (c Chart) IsOCI() bool { return c.RepoURL == "" }

// RemoteRef is the chart reference without any local cache.
func (c Chart) RemoteRef() string {
	if c.IsOCI() {
		return c.Chart
	}
	return c.Repo + "/" + c.Chart
}

// CacheFile is where a pre-downloaded tarball of this chart lives.
func (c Chart) CacheFile() string {
	return filepath.Join(ChartCacheDir, fmt.Sprintf("%s-%s.tgz", c.Name, c.Version))
}

// Ref returns the chart arguments for `helm upgrade --install <release> <Ref>`
// or `helm template`: a local tarball when cached, otherwise a remote ref.
// Classic charts use `--repo <url>` so no `helm repo add` / `helm repo update`
// (each of which downloads a full repo index) is ever needed.
func (c Chart) Ref() string {
	if _, err := os.Stat(c.CacheFile()); err == nil {
		return c.CacheFile()
	}
	return c.PullArgs()
}

// BaseName is the chart name without repo or registry path.
func (c Chart) BaseName() string {
	if c.IsOCI() {
		return path.Base(c.Chart)
	}
	return c.Chart
}

// MirrorPullArgs is the GHCR mirror reference usable by `helm pull`.
func (c Chart) MirrorPullArgs() string {
	return fmt.Sprintf("%s/%s --version %s", ChartMirror, c.BaseName(), c.Version)
}

// PullArgs is the remote reference usable by `helm pull` / `helm install`.
func (c Chart) PullArgs() string {
	if c.IsOCI() {
		return fmt.Sprintf("%s --version %s", c.Chart, c.Version)
	}
	return fmt.Sprintf("%s --repo %s --version %s", c.Chart, c.RepoURL, c.Version)
}

// Bitnami charts come from OCI: no multi-megabyte index.yaml download.
const bitnamiOCI = "oci://registry-1.docker.io/bitnamicharts/"

var charts = map[string]Chart{
	"ingress-nginx":                {Name: "ingress-nginx", Repo: "ingress-nginx", RepoURL: "https://kubernetes.github.io/ingress-nginx", Chart: "ingress-nginx", Version: "4.15.1"},
	"cert-manager":                 {Name: "cert-manager", Repo: "jetstack", RepoURL: "https://charts.jetstack.io", Chart: "cert-manager", Version: "v1.21.3"},
	"postgresql":                   {Name: "postgresql", Chart: bitnamiOCI + "postgresql", Version: "18.12.18"},
	"mongodb":                      {Name: "mongodb", Chart: bitnamiOCI + "mongodb", Version: "20.0.17"},
	"redis":                        {Name: "redis", Chart: bitnamiOCI + "redis", Version: "28.3.12"},
	"minio":                        {Name: "minio", Chart: bitnamiOCI + "minio", Version: "17.0.21"},
	"argo-cd":                      {Name: "argo-cd", Repo: "argo", RepoURL: "https://argoproj.github.io/argo-helm", Chart: "argo-cd", Version: "10.14.0"},
	"argocd-image-updater":         {Name: "argocd-image-updater", Repo: "argo", RepoURL: "https://argoproj.github.io/argo-helm", Chart: "argocd-image-updater", Version: "1.4.2"},
	"kube-prometheus-stack":        {Name: "kube-prometheus-stack", Repo: "prometheus-community", RepoURL: "https://prometheus-community.github.io/helm-charts", Chart: "kube-prometheus-stack", Version: "92.22.0"},
	"loki-stack":                   {Name: "loki-stack", Repo: "grafana", RepoURL: "https://grafana.github.io/helm-charts", Chart: "loki-stack", Version: "2.10.3"},
	"loki":                         {Name: "loki", Repo: "grafana", RepoURL: "https://grafana.github.io/helm-charts", Chart: "loki", Version: "6.30.1"},
	"alloy":                        {Name: "alloy", Repo: "grafana", RepoURL: "https://grafana.github.io/helm-charts", Chart: "alloy", Version: "1.15.0"},
	"tempo":                        {Name: "tempo", Repo: "grafana", RepoURL: "https://grafana.github.io/helm-charts", Chart: "tempo", Version: "1.23.3"},
	"pyroscope":                    {Name: "pyroscope", Repo: "grafana", RepoURL: "https://grafana.github.io/helm-charts", Chart: "pyroscope", Version: "2.4.3"},
	"prometheus-blackbox-exporter": {Name: "prometheus-blackbox-exporter", Repo: "prometheus-community", RepoURL: "https://prometheus-community.github.io/helm-charts", Chart: "prometheus-blackbox-exporter", Version: "11.20.3"},
	"oauth2-proxy":                 {Name: "oauth2-proxy", Repo: "oauth2-proxy", RepoURL: "https://oauth2-proxy.github.io/manifests", Chart: "oauth2-proxy", Version: "10.7.2"},
	"portainer":                    {Name: "portainer", Repo: "portainer", RepoURL: "https://portainer.github.io/k8s/", Chart: "portainer", Version: "245.3.0"},
	// Kyverno is opt-in (full profile + INSTALL_KYVERNO); ~200 MB control plane.
	"kyverno": {Name: "kyverno", Repo: "kyverno", RepoURL: "https://kyverno.github.io/kyverno/", Chart: "kyverno", Version: "3.3.7"},
}

// Get returns a pinned chart; it panics on an unknown name (programming error).
func Get(name string) Chart {
	c, ok := charts[name]
	if !ok {
		panic("versions: unknown chart " + name)
	}
	return c
}

// All returns every pinned chart sorted by name.
func All() []Chart {
	out := make([]Chart, 0, len(charts))
	for _, c := range charts {
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// Repos returns the distinct classic (non-OCI) Helm repos, alias → URL.
func Repos() map[string]string {
	out := map[string]string{}
	for _, c := range charts {
		if !c.IsOCI() {
			out[c.Repo] = c.RepoURL
		}
	}
	return out
}
