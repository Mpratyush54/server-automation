package images

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
)

const (
	dg1 = "sha256:594ceea76b01c592858f803f9ff4d2cb40542cae2060410b2c95f75907d659e1"
	dg2 = "sha256:01038e7de14b78d702d2849c3aad72fd25903c4765af63cf16aa3398f5d5f2dd"
)

func TestDigestAlias(t *testing.T) {
	for _, tc := range []struct {
		ref, tag, digest string
		ok               bool
	}{
		{ref: "registry.k8s.io/ingress-nginx/controller:v1.15.1@" + dg1,
			tag: "registry.k8s.io/ingress-nginx/controller:v1.15.1", digest: "registry.k8s.io/ingress-nginx/controller@" + dg1, ok: true},
		{ref: "nginx:1.27@" + dg1, tag: "docker.io/library/nginx:1.27", digest: "docker.io/library/nginx@" + dg1, ok: true},
		{ref: "bitnami/redis:7@" + dg1, tag: "docker.io/bitnami/redis:7", digest: "docker.io/bitnami/redis@" + dg1, ok: true},
		{ref: "localhost:5000/app:1@" + dg1, tag: "localhost:5000/app:1", digest: "localhost:5000/app@" + dg1, ok: true},
		{ref: "registry.example.com:5000/app@" + dg1},  // no tag: the archive cannot name it
		{ref: "registry.k8s.io/pause:3.10"},            // not pinned
		{ref: "registry.k8s.io/pause:3.10@sha256:abc"}, // malformed digest
	} {
		tag, digest, ok := DigestAlias(tc.ref)
		if ok != tc.ok || tag != tc.tag || digest != tc.digest {
			t.Errorf("DigestAlias(%q) = %q, %q, %v; want %q, %q, %v", tc.ref, tag, digest, ok, tc.tag, tc.digest, tc.ok)
		}
	}
}

// The embedded list pins ingress-nginx by digest; these are what an offline
// node must resolve without a registry.
func TestDigestPinnedListsIngressImages(t *testing.T) {
	pinned := DigestPinned()
	var controller, certgen bool
	for _, img := range pinned {
		controller = controller || strings.HasPrefix(img, "registry.k8s.io/ingress-nginx/controller:")
		certgen = certgen || strings.HasPrefix(img, "registry.k8s.io/ingress-nginx/kube-webhook-certgen:")
	}
	if !controller || !certgen {
		t.Fatalf("DigestPinned() = %v, want the ingress-nginx controller and certgen", pinned)
	}
}

// ctrFake models containerd's image names in the k8s.io namespace.
type ctrFake struct {
	names map[string]bool
	calls []string
	fail  error
}

func (f *ctrFake) run(_ context.Context, name string, args ...string) ([]byte, error) {
	f.calls = append(f.calls, name+" "+strings.Join(args, " "))
	if name != "k3s" || len(args) < 5 || args[0] != "ctr" || args[1] != "-n" || args[2] != "k8s.io" || args[3] != "images" {
		return nil, errors.New("unexpected command")
	}
	switch args[4] {
	case "ls":
		var out []string
		for n := range f.names {
			out = append(out, n)
		}
		return []byte(strings.Join(out, "\n") + "\n"), nil
	case "tag":
		if f.fail != nil {
			return []byte("ctr: boom"), f.fail
		}
		if !f.names[args[5]] {
			return nil, errors.New("source missing")
		}
		f.names[args[6]] = true
		return nil, nil
	}
	return nil, errors.New("unexpected command")
}

func withCtr(t *testing.T, f *ctrFake) {
	t.Helper()
	old := Run
	t.Cleanup(func() { Run = old })
	Run = f.run
}

// After k3s imports the bundle, the pinned reference resolves from the image
// imported under its tag: no registry is contacted (the fake has none).
func TestAliasDigestRefsResolvesWithoutRegistry(t *testing.T) {
	controller := "registry.k8s.io/ingress-nginx/controller:v1.15.1@" + dg1
	certgen := "registry.k8s.io/ingress-nginx/kube-webhook-certgen:v1.6.9@" + dg2
	f := &ctrFake{names: map[string]bool{
		"registry.k8s.io/ingress-nginx/controller:v1.15.1":          true,
		"registry.k8s.io/ingress-nginx/kube-webhook-certgen:v1.6.9": true,
		"docker.io/library/redis:7":                                 true,
	}}
	withCtr(t, f)
	res, err := AliasDigestRefs(context.Background(), []string{controller, certgen, controller, "docker.io/library/redis:7"})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"registry.k8s.io/ingress-nginx/controller@" + dg1, "registry.k8s.io/ingress-nginx/kube-webhook-certgen@" + dg2}
	if !reflect.DeepEqual(res.Named, want) || len(res.Present) != 0 || len(res.Missing) != 0 {
		t.Fatalf("result = %+v", res)
	}
	for _, n := range want {
		if !f.names[n] {
			t.Fatalf("%s not resolvable", n)
		}
	}
	for _, c := range f.calls {
		if strings.Contains(c, "pull") {
			t.Fatalf("unexpected pull: %s", c)
		}
	}

	// A second run (re-run of provision or join) changes nothing.
	f.calls = nil
	res, err = AliasDigestRefs(context.Background(), []string{controller, certgen})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Named) != 0 || !reflect.DeepEqual(res.Present, want) || len(f.calls) != 1 {
		t.Fatalf("second run: %+v, calls %v", res, f.calls)
	}
}

func TestAliasDigestRefsReportsMissingAndErrors(t *testing.T) {
	controller := "registry.k8s.io/ingress-nginx/controller:v1.15.1@" + dg1
	f := &ctrFake{names: map[string]bool{}}
	withCtr(t, f)
	res, err := AliasDigestRefs(context.Background(), []string{controller})
	if err != nil || !reflect.DeepEqual(res.Missing, []string{controller}) {
		t.Fatalf("missing image: %+v, %v", res, err)
	}

	f = &ctrFake{names: map[string]bool{"registry.k8s.io/ingress-nginx/controller:v1.15.1": true}, fail: errors.New("exit status 1")}
	withCtr(t, f)
	if _, err := AliasDigestRefs(context.Background(), []string{controller}); err == nil || !strings.Contains(err.Error(), "ctr: boom") {
		t.Fatalf("tag failure: %v", err)
	}
}
