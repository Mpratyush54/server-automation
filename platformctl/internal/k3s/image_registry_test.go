package k3s

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestImageRegistryAuthMergesWithGHCRAndMirror(t *testing.T) {
	auth := &ImageRegistryAuth{Registry: "registry.cairnpaas.dev", Username: "u1", Password: "p\"1"}
	got := renderRegistries("ghtoken", BuildRegistrySettings{Host: "registry.example.com", Endpoint: "http://10.43.0.5:5000"}, auth)
	want := "configs:\n" +
		"  \"ghcr.io\":\n    auth:\n      username: oauth2\n      password: \"ghtoken\"\n" +
		"  \"registry.cairnpaas.dev\":\n    auth:\n      username: \"u1\"\n      password: \"p\\\"1\"\n" +
		"mirrors:\n  \"registry.example.com\":\n    endpoint: [\"http://10.43.0.5:5000\"]\n"
	if got != want {
		t.Fatalf("got:\n%s\nwant:\n%s", got, want)
	}
	if strings.Count(renderRegistries("", BuildRegistrySettings{}, auth), "configs:") != 1 {
		t.Fatal("auth alone must render one configs block")
	}
}

func TestWriteImageRegistryAuth(t *testing.T) {
	dir := t.TempDir()
	oldAuth, oldReg, oldBuild := imageRegistryAuthPath, registriesPath, buildRegistrySettingsPath
	t.Cleanup(func() { imageRegistryAuthPath, registriesPath, buildRegistrySettingsPath = oldAuth, oldReg, oldBuild })
	imageRegistryAuthPath = filepath.Join(dir, "auth.json")
	registriesPath = filepath.Join(dir, "registries.yaml")
	buildRegistrySettingsPath = filepath.Join(dir, "build.json")
	os.WriteFile(buildRegistrySettingsPath, []byte(`{"Host":"registry.example.com","Endpoint":"http://10.43.0.5:5000"}`), 0o600)

	a := ImageRegistryAuth{Registry: "registry.cairnpaas.dev", Username: "u", Password: "secret"}
	changed, err := WriteImageRegistryAuth("ghtoken", a)
	if err != nil || !changed {
		t.Fatalf("changed=%v err=%v", changed, err)
	}
	b, _ := os.ReadFile(registriesPath)
	for _, w := range []string{"ghcr.io", "registry.cairnpaas.dev", `"secret"`, "mirrors:"} {
		if !strings.Contains(string(b), w) {
			t.Fatalf("missing %s in:\n%s", w, b)
		}
	}
	if runtime.GOOS != "windows" {
		for _, p := range []string{registriesPath, imageRegistryAuthPath} {
			if fi, _ := os.Stat(p); fi.Mode().Perm() != 0o600 {
				t.Fatalf("%s mode %v", p, fi.Mode())
			}
		}
	}
	if changed, _ := WriteImageRegistryAuth("ghtoken", a); changed {
		t.Fatal("unchanged credentials reported a change")
	}
	if got, ok := ReadImageRegistryAuth(); !ok || got != a {
		t.Fatalf("read %+v %v", got, ok)
	}
	if _, err := WriteImageRegistryAuth("", ImageRegistryAuth{Registry: "bad host", Username: "u", Password: "p"}); err == nil {
		t.Fatal("invalid host accepted")
	}
}
