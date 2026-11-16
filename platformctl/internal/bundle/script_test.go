package bundle

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// Stubs for the network and container tools scripts/build-bundle.sh calls.
// Every call is appended to $STUB_LOG.
var buildBundleStubs = map[string]string{
	"curl": `#!/usr/bin/env bash
out="" url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift ;;
    -H) shift ;;
    -*) ;;
    *) url="$1" ;;
  esac
  shift
done
echo "curl $url" >> "$STUB_LOG"
case "$url" in
  *k3s-airgap-images-*) printf airgap > "$out" ;;
  */sha256sum-*.txt) printf '%s  k3s\n' "$(printf k3sbin | sha256sum | cut -d' ' -f1)" > "$out" ;;
  */install.sh) printf '#!/bin/sh\n' > "$out" ;;
  */k3s|*/k3s-arm64) printf k3sbin > "$out" ;;
  https://get.helm.sh/*.tar.gz) cp "$FIXTURES/helm.tgz" "$out" ;;
  https://get.helm.sh/*.sha256sum) cp "$FIXTURES/helm.sha256sum" "$out" ;;
  https://dl.example.test/*/cairn-license-linux-amd64) printf license-client > "$out" ;;
  *) echo "unexpected download $url" >&2; exit 22 ;;
esac
`,
	"docker": `#!/usr/bin/env bash
echo "docker $*" >> "$STUB_LOG"
case "$1" in
  info) ;;
  pull) case "$*" in *"${STUB_MISSING:-no-such-image}"*) exit 1 ;; esac ;;
  image)
    case "$*" in
      *RepoDigests*) ref="${*: -1}"; printf '%s@sha256:%s\n' "${ref%:*}" "$(printf %s "$ref" | sha256sum | cut -c1-64)" ;;
      *) echo amd64 ;;
    esac ;;
  tag) ;;
  save) printf 'saved:%s\n' "$*" ;;
  run)
    cat > /dev/null
    for a; do case "$a" in *:/packages) dir="${a%:/packages}" ;; esac; done
    printf 'Package: open-iscsi\n' > "$dir/Packages"
    printf deb > "$dir/open-iscsi_1_amd64.deb" ;;
  *) echo "unexpected docker $*" >&2; exit 1 ;;
esac
`,
	"helm": `#!/usr/bin/env bash
echo "helm $*" >> "$STUB_LOG"
case "$1" in
  repo) ;;
  pull)
    while [ $# -gt 0 ]; do [ "$1" = --destination ] && dest="$2"; shift; done
    printf chart > "$dest/chart.tgz" ;;
esac
`,
	"zstd": `#!/usr/bin/env bash
while [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done
cat > "$out"
`,
}

const testHelmVersion = "v3.18.4"

type bundleScriptRun struct {
	stage string
	log   string
	out   string
	err   error
}

// runBuildBundle runs scripts/build-bundle.sh with stubbed tools and returns
// the staged bundle directory (STAGE_ONLY). Needs bash, jq, tar, gzip and
// sha256sum (Linux CI; skipped where they are missing).
func runBuildBundle(t *testing.T, helmSum string, env ...string) bundleScriptRun {
	t.Helper()
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skip("bash unavailable")
	}
	for _, tool := range []string{"jq", "tar", "gzip", "sha256sum", "xargs"} {
		if exec.Command("bash", "-c", "command -v "+tool).Run() != nil {
			t.Skipf("%s unavailable", tool)
		}
	}
	dir := t.TempDir()
	bin := filepath.Join(dir, "bin")
	fixtures := filepath.Join(dir, "fixtures")
	for _, d := range []string{bin, fixtures} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for name, body := range buildBundleStubs {
		if err := os.WriteFile(filepath.Join(bin, name), []byte(body), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	tgz := helmTarball(t, "linux-amd64/helm", "helm-binary")
	if err := os.WriteFile(filepath.Join(fixtures, "helm.tgz"), tgz, 0o644); err != nil {
		t.Fatal(err)
	}
	if helmSum == "" {
		helmSum = sha(string(tgz))
	}
	sumLine := fmt.Sprintf("%s  helm-%s-linux-amd64.tar.gz\n", helmSum, testHelmVersion)
	if err := os.WriteFile(filepath.Join(fixtures, "helm.sha256sum"), []byte(sumLine), 0o644); err != nil {
		t.Fatal(err)
	}
	charts := `{"k3s":"v1.33.1+k3s1","helm":"` + testHelmVersion + `","chartMirror":"oci://ghcr.io/example/charts",` +
		`"charts":[{"name":"ingress-nginx","repo":"ingress-nginx","repoUrl":"https://kubernetes.github.io/ingress-nginx","chart":"ingress-nginx","version":"4.13.0"}]` +
		testLicenseClient + `}`
	chartsFile := filepath.Join(fixtures, "charts.json")
	imagesFile := filepath.Join(fixtures, "images.txt")
	images := "# test\nregistry.k8s.io/ingress-nginx/controller:v1.15.1@sha256:" + strings.Repeat("a", 64) + "\nregistry.k8s.io/pause:3.10\n"
	if err := os.WriteFile(chartsFile, []byte(charts), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(imagesFile, []byte(images), 0o644); err != nil {
		t.Fatal(err)
	}
	stage := filepath.Join(dir, "stage")
	log := filepath.Join(dir, "stub.log")
	script := filepath.Join("..", "..", "..", "scripts", "build-bundle.sh")
	cmd := exec.Command("bash", filepath.ToSlash(script), "v0.0.0-test", "amd64")
	cmd.Env = append(os.Environ(),
		"PATH="+bin+string(os.PathListSeparator)+os.Getenv("PATH"),
		"STUB_LOG="+filepath.ToSlash(log), "FIXTURES="+filepath.ToSlash(fixtures),
		"CHARTS_JSON="+filepath.ToSlash(chartsFile), "IMAGES_TXT="+filepath.ToSlash(imagesFile),
		"STAGE_ONLY="+filepath.ToSlash(stage), "OUT_DIR="+filepath.ToSlash(filepath.Join(dir, "dist")), "GITHUB_TOKEN=")
	cmd.Env = append(cmd.Env, env...)
	out, err := cmd.CombinedOutput()
	logData, _ := os.ReadFile(log)
	return bundleScriptRun{stage: stage, log: string(logData), out: string(out), err: err}
}

func helmTarball(t *testing.T, name, body string) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o755, Size: int64(len(body)), Typeflag: tar.TypeReg}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write([]byte(body)); err != nil {
		t.Fatal(err)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// The release bundle carries the checksum-verified Helm binary, listed in
// SHA256SUMS, and saves digest-pinned images under their tag.
func TestBuildBundleScriptHelmAndDigestImages(t *testing.T) {
	r := runBuildBundle(t, "")
	if r.err != nil {
		t.Fatalf("build-bundle.sh: %v\n%s", r.err, r.out)
	}
	got, err := os.ReadFile(filepath.Join(r.stage, "helm", "helm"))
	if err != nil || string(got) != "helm-binary" {
		t.Fatalf("staged helm = %q, %v", got, err)
	}
	if runtime.GOOS != "windows" {
		if fi, _ := os.Stat(filepath.Join(r.stage, "helm", "helm")); fi.Mode().Perm()&0o111 == 0 {
			t.Fatal("staged helm is not executable")
		}
	}
	sums, err := os.ReadFile(filepath.Join(r.stage, "SHA256SUMS"))
	// "*" marks binary mode (sha256sum on Windows); parseSums accepts both.
	if err != nil || (!strings.Contains(string(sums), sha("helm-binary")+"  helm/helm\n") &&
		!strings.Contains(string(sums), sha("helm-binary")+" *helm/helm\n")) {
		t.Fatalf("SHA256SUMS does not cover helm/helm:\n%s", sums)
	}
	if !strings.Contains(r.log, "curl https://get.helm.sh/helm-"+testHelmVersion+"-linux-amd64.tar.gz\n") {
		t.Fatalf("helm not fetched from get.helm.sh:\n%s", r.log)
	}

	pinned := "registry.k8s.io/ingress-nginx/controller:v1.15.1@sha256:" + strings.Repeat("a", 64)
	if !strings.Contains(r.log, "docker tag "+pinned+" registry.k8s.io/ingress-nginx/controller:v1.15.1\n") {
		t.Fatalf("digest-pinned image not tagged:\n%s", r.log)
	}
	var saves []string
	for _, line := range strings.Split(r.log, "\n") {
		if strings.HasPrefix(line, "docker save ") {
			saves = append(saves, line)
		}
	}
	if len(saves) != 2 || saves[0] != "docker save registry.k8s.io/ingress-nginx/controller:v1.15.1 registry.k8s.io/pause:3.10" {
		t.Fatalf("docker save must use tag references only, got %q", saves)
	}
	manifest, _ := os.ReadFile(filepath.Join(r.stage, "manifest.json"))
	if !strings.Contains(string(manifest), pinned) {
		t.Fatalf("manifest.json must keep the pinned reference:\n%s", manifest)
	}

	// The Cairn images of the release tag, saved under their tag into their
	// own archive and pinned by registry digest in the checksummed manifest.
	var cairn []string
	for _, repo := range []string{"platform-api", "platform-portal", "platform-profile-ingest", "platform-synthetics-runner"} {
		cairn = append(cairn, "ghcr.io/mpratyush54/"+repo+":0.0.0-test")
	}
	if saves[1] != "docker save "+strings.Join(cairn, " ") {
		t.Fatalf("Cairn images saved as %q", saves[1])
	}
	if _, err := os.Stat(filepath.Join(r.stage, "images", "cairn-images-amd64.tar.zst")); err != nil {
		t.Fatal(err)
	}
	var m Manifest
	if err := json.Unmarshal(manifest, &m); err != nil {
		t.Fatal(err)
	}
	if m.PlatformImageTag != "0.0.0-test" || len(m.PlatformImages) != len(cairn) {
		t.Fatalf("manifest Cairn images: %+v", m)
	}
	for i, ref := range m.PlatformImages {
		if !strings.HasPrefix(ref, cairn[i]+"@sha256:") || len(ref) != len(cairn[i])+len("@sha256:")+64 {
			t.Fatalf("%q is not %s pinned by digest", ref, cairn[i])
		}
	}
	if !strings.Contains(string(sums), " manifest.json\n") && !strings.Contains(string(sums), " *manifest.json\n") {
		t.Fatalf("SHA256SUMS does not cover manifest.json:\n%s", sums)
	}
}

func TestBuildBundleScriptRejectsBadHelmChecksum(t *testing.T) {
	r := runBuildBundle(t, strings.Repeat("0", 64))
	if r.err == nil || !strings.Contains(r.out, "helm archive checksum mismatch") {
		t.Fatalf("want checksum failure, got %v:\n%s", r.err, r.out)
	}
}

// A release bundle without its Cairn images is not built.
func TestBuildBundleScriptRequiresCairnImages(t *testing.T) {
	r := runBuildBundle(t, "", "STUB_MISSING=platform-portal:")
	if r.err == nil || !strings.Contains(r.out, "ghcr.io/mpratyush54/platform-portal:0.0.0-test is not available") {
		t.Fatalf("want missing image failure, got %v:\n%s", r.err, r.out)
	}
}

// Stack builds (SKIP_PACKAGES=1) carry neither node packages, Helm nor the Cairn images.
func TestBuildBundleScriptStackSkipsHelm(t *testing.T) {
	r := runBuildBundle(t, "", "SKIP_PACKAGES=1")
	if r.err != nil {
		t.Fatalf("build-bundle.sh: %v\n%s", r.err, r.out)
	}
	if strings.Contains(r.log, "get.helm.sh") {
		t.Fatalf("stack build fetched helm:\n%s", r.log)
	}
	if _, err := os.Stat(filepath.Join(r.stage, "helm", "helm")); !os.IsNotExist(err) {
		t.Fatal("stack build staged helm")
	}
	if entries, _ := os.ReadDir(filepath.Join(r.stage, "packages")); len(entries) != 0 {
		t.Fatal("stack build staged packages")
	}
	if strings.Contains(r.log, "platform-api") {
		t.Fatalf("stack build pulled the Cairn images:\n%s", r.log)
	}
	if _, err := os.Stat(filepath.Join(r.stage, "images", "cairn-images-amd64.tar.zst")); !os.IsNotExist(err) {
		t.Fatal("stack build staged the Cairn images")
	}
}

// testLicenseClient is appended to the charts JSON fixture.
var testLicenseClient = ""

func TestBuildBundleScriptLicenseClient(t *testing.T) {
	r := runBuildBundle(t, "")
	if r.err != nil {
		t.Fatalf("build-bundle.sh: %v\n%s", r.err, r.out)
	}
	if _, err := os.Stat(filepath.Join(r.stage, "license", "cairn-license")); err == nil {
		t.Fatal("license client bundled without a pin")
	}
	testLicenseClient = `,"licenseClient":{"version":"v1.0.0","baseUrl":"https://dl.example.test/cairn-license","sha256":{"amd64":"` + sha("license-client") + `"}}`
	t.Cleanup(func() { testLicenseClient = "" })
	r = runBuildBundle(t, "")
	if r.err != nil {
		t.Fatalf("build-bundle.sh: %v\n%s", r.err, r.out)
	}
	got, err := os.ReadFile(filepath.Join(r.stage, "license", "cairn-license"))
	if err != nil || string(got) != "license-client" {
		t.Fatalf("staged client = %q, %v", got, err)
	}
	sums, _ := os.ReadFile(filepath.Join(r.stage, "SHA256SUMS"))
	if !strings.Contains(string(sums), "license/cairn-license") {
		t.Fatalf("SHA256SUMS does not cover the client:\n%s", sums)
	}
	testLicenseClient = `,"licenseClient":{"version":"v1.0.0","baseUrl":"https://dl.example.test/cairn-license","sha256":{"amd64":"` + sha("other") + `"}}`
	if r = runBuildBundle(t, ""); r.err == nil || !strings.Contains(r.out, "checksum mismatch") {
		t.Fatalf("mismatch not refused: %v\n%s", r.err, r.out)
	}
}
