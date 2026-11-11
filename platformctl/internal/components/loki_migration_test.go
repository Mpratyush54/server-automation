package components

import (
	"strings"
	"testing"
)

func fakeLoki(t *testing.T, outputs map[string]string) *[]string {
	t.Helper()
	var ran []string
	oldOut, oldRun := lokiOutput, lokiRun
	t.Cleanup(func() { lokiOutput, lokiRun = oldOut, oldRun })
	lokiOutput = func(cmd string, args ...string) (string, error) {
		line := cmd + " " + strings.Join(args, " ")
		for k, v := range outputs {
			if strings.Contains(line, k) {
				return v, nil
			}
		}
		return "", nil
	}
	lokiRun = func(cmd string, args ...string) error {
		ran = append(ran, cmd+" "+strings.Join(args, " "))
		return nil
	}
	return &ran
}

const lokiStackList = `[{"name":"loki","namespace":"monitoring","chart":"loki-stack-2.10.3","revision":"1"}]`

func TestLegacyLokiChart(t *testing.T) {
	for in, want := range map[string]string{
		"":            "",
		"[]":          "",
		lokiStackList: "loki-stack-2.10.3",
		`[{"name":"loki","chart":"loki-6.30.1"}]`:        "",
		`[{"name":"other","chart":"loki-stack-2.10.3"}]`: "",
	} {
		got, err := legacyLokiChart(in)
		if err != nil || got != want {
			t.Errorf("legacyLokiChart(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
}

// v1.2.0 installs loki-stack without persistence: the migration removes it
// with a log line so the new Loki chart can take the release name.
func TestMigrateLegacyLokiStackWithoutVolumeUninstalls(t *testing.T) {
	ran := fakeLoki(t, map[string]string{"helm list": lokiStackList, "get pvc": "persistentvolumeclaim/data-kube-prometheus-0"})
	if err := migrateLegacyLokiStack(); err != nil {
		t.Fatal(err)
	}
	if len(*ran) != 1 || !strings.HasPrefix((*ran)[0], "helm uninstall loki -n monitoring") {
		t.Fatalf("ran %v", *ran)
	}
}

func TestMigrateLegacyLokiStackWithVolumeStops(t *testing.T) {
	for name, outputs := range map[string]map[string]string{
		"claim template": {"helm list": lokiStackList, "statefulset loki": "storage "},
		"pvc":            {"helm list": lokiStackList, "get pvc": "persistentvolumeclaim/storage-loki-0"},
	} {
		t.Run(name, func(t *testing.T) {
			ran := fakeLoki(t, outputs)
			err := migrateLegacyLokiStack()
			if err == nil || !strings.Contains(err.Error(), "Upgrade from loki-stack") {
				t.Fatalf("err = %v", err)
			}
			if len(*ran) != 0 {
				t.Fatalf("touched the release: %v", *ran)
			}
		})
	}
}

func TestMigrateLegacyLokiStackLeavesNewLokiAlone(t *testing.T) {
	ran := fakeLoki(t, map[string]string{"helm list": `[{"name":"loki","chart":"loki-6.30.1"}]`})
	if err := migrateLegacyLokiStack(); err != nil || len(*ran) != 0 {
		t.Fatal(err, *ran)
	}
}
