package components

import (
	"context"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/backup"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
)

const ObjectStorageSecret = "platform-object-storage"

func ReadObjectStorageCredentials() (map[string]string, error) { return objectStorageCredentials() }

func objectStorageCredentials() (map[string]string, error) {
	d, err := kubeSecret("platform", ObjectStorageSecret)
	if err != nil || d["OBJECT_STORAGE_ACCESS_KEY"] == "" || d["OBJECT_STORAGE_SECRET_KEY"] == "" {
		return nil, fmt.Errorf("Secret platform/%s needs OBJECT_STORAGE_ACCESS_KEY and OBJECT_STORAGE_SECRET_KEY", ObjectStorageSecret)
	}
	return d, nil
}

// PrepareObjectStorage runs before k3s and never logs credentials or sends them
// through a command line. Each bucket is checked with a write/read/delete probe.
func PrepareObjectStorage(c *config.Config, credentials map[string]string) error {
	if err := c.ValidateObjectStorage(); err != nil {
		return err
	}
	if !c.ObjectStorageExternal() {
		return nil
	}
	for _, purpose := range config.ObjectStoragePurposes {
		t := backup.S3Target{Endpoint: c.ObjectStorage.Endpoint, Region: c.ObjectStorage.Region, Bucket: c.ObjectBucket(purpose), AccessKey: credentials["OBJECT_STORAGE_ACCESS_KEY"], SecretKey: credentials["OBJECT_STORAGE_SECRET_KEY"]}
		if err := t.Validate(); err != nil {
			return fmt.Errorf("external object storage: %w", err)
		}
		client := backup.NewS3Client(t)
		client.VirtualHostedStyle = !c.ObjectStorage.ForcePathStyle
		ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
		err := client.EnsureBucket(ctx)
		if err == nil {
			err = client.Probe(ctx)
		}
		cancel()
		if err != nil {
			return fmt.Errorf("external object storage (%s): %w", purpose, err)
		}
	}
	return nil
}

func EnsureObjectStorage(c *config.Config, credentials map[string]string) error {
	if !c.ObjectStorageExternal() {
		return nil
	}
	if len(credentials) == 0 {
		var err error
		credentials, err = objectStorageCredentials()
		if err != nil {
			return err
		}
	}
	return applySecret("platform", ObjectStorageSecret, credentials)
}

func objectStorageEnvValues(c *config.Config) map[string]string {
	return map[string]string{
		"OBJECT_STORAGE_MODE": "external", "OBJECT_STORAGE_ENDPOINT": c.ObjectStorage.Endpoint,
		"OBJECT_STORAGE_REGION": c.ObjectStorage.Region, "OBJECT_STORAGE_BUCKET_PREFIX": c.ObjectStorage.BucketPrefix,
		"OBJECT_STORAGE_FORCE_PATH_STYLE": strconv.FormatBool(c.ObjectStorage.ForcePathStyle),
		"UPLOADS_BUCKET":                  c.ObjectBucket("uploads"), "BACKUP_BUCKET": c.ObjectBucket("backups"), "REPLAYS_BUCKET": c.ObjectBucket("replays"),
	}
}

func externalTelemetrySecrets(c *config.Config) error {
	d, err := objectStorageCredentials()
	if err != nil {
		return err
	}
	for _, purpose := range []string{"loki", "tempo", "pyroscope", "replays"} {
		if err := applySecret("monitoring", "telemetry-"+purpose+"-s3", map[string]string{"S3_ACCESS_KEY": d["OBJECT_STORAGE_ACCESS_KEY"], "S3_SECRET_KEY": d["OBJECT_STORAGE_SECRET_KEY"]}); err != nil {
			return err
		}
	}
	return nil
}

func telemetryObjectValues(c *config.Config, name string, days int, sampling float64) string {
	values := telemetryValues(name, days, sampling)
	if !c.ObjectStorageExternal() || (name != "loki" && name != "tempo" && name != "pyroscope") {
		return values
	}
	u, _ := url.Parse(c.ObjectStorage.Endpoint)
	values = strings.NewReplacer(
		"http://minio.storage.svc.cluster.local:9000", c.ObjectStorage.Endpoint,
		"minio.storage.svc.cluster.local:9000", u.Host,
		"insecure: true", "insecure: "+strconv.FormatBool(u.Scheme == "http"),
		"s3ForcePathStyle: true", "s3ForcePathStyle: "+strconv.FormatBool(c.ObjectStorage.ForcePathStyle),
		"bucket: "+name, "bucket: "+c.ObjectBucket(name),
		"bucket_name: "+name, "bucket_name: "+c.ObjectBucket(name),
		"{chunks: loki, ruler: loki, admin: loki}", fmt.Sprintf("{chunks: %s, ruler: %s, admin: %s}", c.ObjectBucket("loki"), c.ObjectBucket("loki"), c.ObjectBucket("loki")),
	).Replace(values)
	if name == "loki" {
		values = strings.ReplaceAll(values, "      accessKeyId:", "      region: "+c.ObjectStorage.Region+"\n      accessKeyId:")
	} else {
		values = strings.ReplaceAll(values, "        endpoint:", "        region: "+c.ObjectStorage.Region+"\n        forcepathstyle: "+strconv.FormatBool(c.ObjectStorage.ForcePathStyle)+"\n        endpoint:")
	}
	if name == "pyroscope" {
		// Pyroscope spells the key force_path_style. false keeps its automatic
		// bucket lookup (virtual-hosted on AWS, path-style elsewhere).
		values = strings.ReplaceAll(values, "forcepathstyle:", "force_path_style:")
	}
	return values
}

func externalStorageRoutingScript(script string) string {
	start := strings.Index(script, "apiVersion: v1\nkind: Service\nmetadata:\n  name: minio-proxy")
	if start >= 0 {
		end := strings.Index(script[start:], "---\n")
		if end >= 0 {
			script = script[:start] + script[start+end+4:]
		}
	}
	lines := strings.Split(script, "\n")
	out := []string{}
	skipHost, skipPath := false, false
	for _, line := range lines {
		if strings.Contains(line, "# MinIO console") || strings.HasPrefix(line, "    - minio.") {
			continue
		}
		if strings.HasPrefix(line, "  - host:") {
			skipHost = strings.HasPrefix(line, "  - host: minio.")
		}
		if strings.HasPrefix(line, "      - path:") {
			skipPath = line == "      - path: /minio"
		}
		if !skipHost && !skipPath {
			out = append(out, line)
		}
	}
	return strings.Join(out, "\n")
}
