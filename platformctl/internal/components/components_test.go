package components

import (
	"testing"
)

func TestAllComponents(t *testing.T) {
	all := All()
	if len(all) == 0 {
		t.Fatal("All() returned no components")
	}
	if len(all) != 12 {
		t.Errorf("expected 12 components, got %d", len(all))
	}
}

func TestAllComponentsHaveNames(t *testing.T) {
	for _, c := range All() {
		if c.Name == "" {
			t.Error("component has empty Name")
		}
		if c.Description == "" {
			t.Errorf("component %q has empty Description", c.Name)
		}
		if c.Install == nil {
			t.Errorf("component %q has nil Install function", c.Name)
		}
	}
}

func TestAllUniqueNames(t *testing.T) {
	seen := make(map[string]bool)
	for _, c := range All() {
		if seen[c.Name] {
			t.Errorf("duplicate component name: %s", c.Name)
		}
		seen[c.Name] = true
	}
}

func TestFindExisting(t *testing.T) {
	names := []string{"argocd", "postgresql", "monitoring", "ingress-nginx", "cert-manager", "platform"}
	for _, name := range names {
		c := Find(name)
		if c == nil {
			t.Errorf("Find(%q) returned nil", name)
		}
	}
}

func TestFindMissing(t *testing.T) {
	c := Find("nonexistent-component")
	if c != nil {
		t.Errorf("expected nil for missing component, got %+v", c)
	}
}

func TestFindCaseSensitive(t *testing.T) {
	c := Find("ArgoCD")
	if c != nil {
		t.Error("Find should be case-sensitive, 'ArgoCD' should not match 'argocd'")
	}
}

func TestAllDescriptionsCoverage(t *testing.T) {
	descriptions := map[string]string{}
	for _, c := range All() {
		descriptions[c.Name] = c.Description
	}

	tests := []struct {
		name     string
		contains string
	}{
		{"argocd", "GitOps"},
		{"postgresql", "database"},
		{"monitoring", "Grafana"},
		{"ingress-nginx", "Ingress"},
		{"cert-manager", "certificate"},
		{"platform", "API"},
	}

	for _, tt := range tests {
		desc, ok := descriptions[tt.name]
		if !ok {
			t.Errorf("component %q not found", tt.name)
			continue
		}
		if !contains(desc, tt.contains) {
			t.Errorf("description for %q should contain %q, got %q", tt.name, tt.contains, desc)
		}
	}
}

func TestComponentNamesKebabCase(t *testing.T) {
	for _, c := range All() {
		for _, r := range c.Name {
			if r >= 'A' && r <= 'Z' {
				t.Errorf("component name %q should be kebab-case (no uppercase)", c.Name)
				break
			}
		}
	}
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && containsStr(s, substr)
}

func containsStr(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}

func TestGenerateDemoPassword(t *testing.T) {
	pw := generateDemoPassword()
	if pw != "admin123" {
		t.Errorf("expected 'admin123', got %q", pw)
	}
}
