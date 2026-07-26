package manifests

import (
	"strings"
	"testing"
)

func TestReadExisting(t *testing.T) {
	names, err := List()
	if err != nil {
		t.Fatalf("List() failed: %v", err)
	}
	if len(names) == 0 {
		t.Fatal("no manifests found in embedded data")
	}

	data, err := Read(names[0])
	if err != nil {
		t.Fatalf("Read(%q) failed: %v", names[0], err)
	}
	if len(data) == 0 {
		t.Errorf("Read(%q) returned empty data", names[0])
	}
}

func TestReadMissing(t *testing.T) {
	_, err := Read("nonexistent-file.yaml")
	if err == nil {
		t.Error("expected error for missing manifest, got nil")
	}
}

func TestListNonEmpty(t *testing.T) {
	names, err := List()
	if err != nil {
		t.Fatalf("List() failed: %v", err)
	}
	if len(names) == 0 {
		t.Fatal("List() returned no manifests")
	}
}

func TestListContainsExpected(t *testing.T) {
	names, err := List()
	if err != nil {
		t.Fatalf("List() failed: %v", err)
	}

	expected := []string{"argocd-values.yaml", "grafana-values.yaml", "minio-values.yaml"}
	for _, e := range expected {
		found := false
		for _, n := range names {
			if n == e {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("expected manifest %q not found in list", e)
		}
	}
}

func TestReadAllManifests(t *testing.T) {
	names, err := List()
	if err != nil {
		t.Fatalf("List() failed: %v", err)
	}

	for _, name := range names {
		data, err := Read(name)
		if err != nil {
			t.Errorf("Read(%q) failed: %v", name, err)
			continue
		}
		if len(data) == 0 {
			t.Errorf("%q is empty", name)
		}
	}
}

func TestManifestContentIsYAML(t *testing.T) {
	data, err := Read("minio-values.yaml")
	if err != nil {
		t.Fatalf("Read failed: %v", err)
	}

	content := string(data)
	if !strings.Contains(content, ":") {
		t.Error("manifest does not look like YAML (no colon)")
	}
}
