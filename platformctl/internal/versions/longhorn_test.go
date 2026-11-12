package versions

import "testing"

func TestLonghornPinned(t *testing.T) {
	c := Get("longhorn")
	if c.Name != "longhorn" || c.Repo != "longhorn" || c.RepoURL != "https://charts.longhorn.io" || c.Chart != "longhorn" || c.Version != "1.12.1" {
		t.Fatalf("unexpected chart: %+v", c)
	}
}
