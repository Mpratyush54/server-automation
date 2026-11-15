package components

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
)

func externalObjectConfig() *config.Config {
	return &config.Config{Profile: config.ProfileHA, Domain: "example.com", BuildsEnabled: true,
		ObjectStorage: config.ObjectStorageSettings{Mode: "external", Endpoint: "https://objects.example.com", Region: "eu-west-1", BucketPrefix: "test-cairn", ForcePathStyle: false}}
}

func TestExternalObjectValues(t *testing.T) {
	c := externalObjectConfig()
	for _, backend := range []string{"loki", "tempo", "pyroscope"} {
		values := telemetryObjectValues(c, backend, 7, 100)
		for _, want := range []string{"test-cairn-" + backend, "objects.example.com", "eu-west-1", "insecure: false", "168h", "${S3_SECRET_KEY}"} {
			if !strings.Contains(values, want) {
				t.Errorf("%s missing %s", backend, want)
			}
		}
		if strings.Contains(values, "minio.storage") {
			t.Fatal("bundled endpoint remains")
		}
	}
	manifest, err := BuildRegistryManifest(c, testRealm, DefaultBuildNetworks())
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`region: "eu-west-1"`, `regionendpoint: "https://objects.example.com"`, `bucket: "test-cairn-registry"`, "forcepathstyle: false", "registry-storage"} {
		if !strings.Contains(manifest, want) {
			t.Error("registry missing " + want)
		}
	}
	env := platformEnvValues(c)
	if env["UPLOADS_BUCKET"] != "test-cairn-uploads" || env["REPLAYS_BUCKET"] != "test-cairn-replays" || env["BACKUP_BUCKET"] != "test-cairn-backups" {
		t.Fatal(env)
	}
	for _, key := range []string{"MINIO_ENDPOINT", "MINIO_API_ACCESS_KEY", "OBJECT_STORAGE_ACCESS_KEY", "OBJECT_STORAGE_SECRET_KEY"} {
		if _, ok := env[key]; ok {
			t.Fatal("unexpected bundled setting or object credential in API env values")
		}
	}
	b, err := pgBackupTarget(c)
	if err != nil || b.Endpoint != c.ObjectStorage.Endpoint || b.Destination != "s3://test-cairn-backups/postgres/" {
		t.Fatal(b, err)
	}
}

func TestExternalStorageSkipsBundledSetup(t *testing.T) {
	c := externalObjectConfig()
	if err := InstallMinIO(c); err != nil {
		t.Fatal(err)
	}
	if err := SetupBundledStorage(c); err != nil {
		t.Fatal(err)
	}
	old := applyLonghornMinioStorageClass
	defer func() { applyLonghornMinioStorageClass = old }()
	applyLonghornMinioStorageClass = func(int) error { t.Fatal("MinIO class applied"); return nil }
	if err := ensureMinioStorageClass(c, 2); err != nil {
		t.Fatal(err)
	}
	script := externalStorageRoutingScript(serviceRoutingScript("example.com"))
	if strings.Contains(script, "minio") {
		t.Fatal("MinIO console remains in routing")
	}
	for _, want := range []string{"name: platform-api", "name: platform-portal", "- path: /oauth2"} {
		if !strings.Contains(script, want) {
			t.Fatal("routing missing " + want)
		}
	}
}

func TestPrepareObjectStorageCreatesAndProbesEveryBucket(t *testing.T) {
	objects := map[string]string{}
	methods := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		methods = append(methods, r.Method)
		switch r.Method {
		case "HEAD":
			w.WriteHeader(404)
		case "PUT":
			b, _ := io.ReadAll(r.Body)
			objects[r.URL.Path] = string(b)
		case "GET":
			io.WriteString(w, objects[r.URL.Path])
		case "DELETE":
			delete(objects, r.URL.Path)
			w.WriteHeader(204)
		}
	}))
	defer server.Close()
	c := externalObjectConfig()
	c.ObjectStorage.Endpoint = server.URL
	c.ObjectStorage.ForcePathStyle = true
	if err := PrepareObjectStorage(c, map[string]string{"OBJECT_STORAGE_ACCESS_KEY": "test", "OBJECT_STORAGE_SECRET_KEY": "test"}); err != nil {
		t.Fatal(err)
	}
	if strings.Join(methods, ",") != strings.TrimSuffix(strings.Repeat("HEAD,PUT,PUT,GET,DELETE,", len(config.ObjectStoragePurposes)), ",") {
		t.Fatal(methods)
	}
	if len(objects) != len(config.ObjectStoragePurposes) {
		t.Fatal("probe object left behind")
	}
}

func TestPrepareObjectStorageDeniesBeforeProvision(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(403) }))
	defer server.Close()
	c := externalObjectConfig()
	c.ObjectStorage.Endpoint = server.URL
	c.ObjectStorage.ForcePathStyle = true
	err := PrepareObjectStorage(c, map[string]string{"OBJECT_STORAGE_ACCESS_KEY": "private-access", "OBJECT_STORAGE_SECRET_KEY": "private-secret"})
	if err == nil || !strings.Contains(err.Error(), "external object storage") || strings.Contains(err.Error(), "private-") {
		t.Fatal(err)
	}
}

func TestExternalObjectSecretsUseStdinWithoutIAMJobs(t *testing.T) {
	calls := fakeTools(t)
	d := map[string]string{"OBJECT_STORAGE_ACCESS_KEY": "external-test-access", "OBJECT_STORAGE_SECRET_KEY": "external-test-secret"}
	stubKube(t, map[string]map[string]string{"platform/" + ObjectStorageSecret: d})
	c := externalObjectConfig()
	if err := EnsureObjectStorage(c, d); err != nil {
		t.Fatal(err)
	}
	if err := telemetryStorage(c); err != nil {
		t.Fatal(err)
	}
	secrets := map[string]bool{}
	for _, call := range calls() {
		args := strings.Join(call.Args, " ")
		if strings.Contains(args, "external-test-") || strings.Contains(args, "minio") || call.Tool != "kubectl" {
			t.Fatal("credentials in argv or bundled bootstrap executed")
		}
		var m struct {
			Kind       string
			Metadata   struct{ Name, Namespace string }
			StringData map[string]string
		}
		if err := json.Unmarshal([]byte(call.Input), &m); err != nil {
			t.Fatal(err)
		}
		if m.Kind != "Secret" {
			t.Fatal("external mode must not create IAM Jobs")
		}
		secrets[m.Metadata.Namespace+"/"+m.Metadata.Name] = true
		if m.Metadata.Name == ObjectStorageSecret {
			if m.StringData["OBJECT_STORAGE_SECRET_KEY"] != d["OBJECT_STORAGE_SECRET_KEY"] {
				t.Fatal("master credentials missing")
			}
		} else if m.StringData["S3_ACCESS_KEY"] != d["OBJECT_STORAGE_ACCESS_KEY"] || m.StringData["S3_SECRET_KEY"] != d["OBJECT_STORAGE_SECRET_KEY"] {
			t.Fatal("consumer credentials missing")
		}
	}
	for _, name := range []string{"platform/platform-object-storage", "monitoring/telemetry-loki-s3", "monitoring/telemetry-tempo-s3", "monitoring/telemetry-pyroscope-s3", "monitoring/telemetry-replays-s3"} {
		if !secrets[name] {
			t.Fatal("missing Secret " + name)
		}
	}
}

// Each backend gets the addressing key its own config format understands.
func TestExternalTelemetryAddressingKeys(t *testing.T) {
	c := externalObjectConfig()
	want := map[string][]string{
		"loki":      {"endpoint: https://objects.example.com", "s3ForcePathStyle: false", "region: eu-west-1", "bucketNames: {chunks: test-cairn-loki"},
		"tempo":     {"endpoint: objects.example.com", "forcepathstyle: false", "bucket: test-cairn-tempo"},
		"pyroscope": {"endpoint: objects.example.com", "force_path_style: false", "bucket_name: test-cairn-pyroscope"},
	}
	for backend, keys := range want {
		values := telemetryObjectValues(c, backend, 7, 100)
		for _, k := range keys {
			if !strings.Contains(values, k) {
				t.Errorf("%s missing %q", backend, k)
			}
		}
		if strings.Contains(values, "bucket_lookup_type") {
			t.Errorf("%s: unsupported bucket_lookup_type value", backend)
		}
	}
	if v := telemetryObjectValues(&config.Config{}, "pyroscope", 7, 100); !strings.Contains(v, "minio.storage.svc.cluster.local:9000") {
		t.Fatal("bundled values changed")
	}
}
