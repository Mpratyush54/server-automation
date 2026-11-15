package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/backup"
)

// ObjectStorageSettings contains only non-secret, fresh-install settings.
type ObjectStorageSettings struct {
	Mode, Endpoint, Region, BucketPrefix string
	ForcePathStyle                       bool
	invalidPathStyle                     bool
}

func (c *Config) ObjectStorageExternal() bool { return c.ObjectStorage.Mode == "external" }

func (c *Config) ObjectBucket(purpose string) string {
	return c.ObjectStorage.BucketPrefix + "-" + purpose
}

func (c *Config) loadObjectStorage() {
	c.ObjectStorage = ObjectStorageSettings{
		Mode:             getEnv("OBJECT_STORAGE_MODE", "bundled"),
		Endpoint:         os.Getenv("OBJECT_STORAGE_ENDPOINT"),
		Region:           getEnv("OBJECT_STORAGE_REGION", "us-east-1"),
		BucketPrefix:     getEnv("OBJECT_STORAGE_BUCKET_PREFIX", "cairn"),
		ForcePathStyle:   getEnvBool("OBJECT_STORAGE_FORCE_PATH_STYLE", true),
		invalidPathStyle: os.Getenv("OBJECT_STORAGE_FORCE_PATH_STYLE") != "" && os.Getenv("OBJECT_STORAGE_FORCE_PATH_STYLE") != "true" && os.Getenv("OBJECT_STORAGE_FORCE_PATH_STYLE") != "false",
	}
	c.NormalizeObjectStorage()
}

func (c *Config) ValidateObjectStorage() error {
	o := c.ObjectStorage
	if o.invalidPathStyle {
		return fmt.Errorf("OBJECT_STORAGE_FORCE_PATH_STYLE must be true or false")
	}
	if o.Mode != "" && o.Mode != "bundled" && o.Mode != "external" {
		return fmt.Errorf("OBJECT_STORAGE_MODE must be bundled or external")
	}
	if !c.ObjectStorageExternal() {
		return nil
	}
	if o.Endpoint == "" || o.Region == "" || o.BucketPrefix == "" {
		return fmt.Errorf("external object storage requires endpoint, region and bucket prefix")
	}
	for _, purpose := range ObjectStoragePurposes {
		if err := (backup.S3Target{Endpoint: o.Endpoint, Region: o.Region, Bucket: c.ObjectBucket(purpose)}).ValidateSettings(); err != nil {
			return fmt.Errorf("object storage: %w", err)
		}
	}
	if strings.Contains(o.BucketPrefix, ".") {
		return fmt.Errorf("OBJECT_STORAGE_BUCKET_PREFIX must not contain dots")
	}
	return nil
}

var ObjectStoragePurposes = []string{"uploads", "backups", "replays", "loki", "tempo", "pyroscope", "registry"}

// objectStorageEnv renders the .env lines. Bundled installs (the default)
// write nothing, so their .env stays byte-stable.
func (c *Config) objectStorageEnv() (string, error) {
	if err := c.ValidateObjectStorage(); err != nil {
		return "", err
	}
	if !c.ObjectStorageExternal() {
		return "", nil
	}
	o := c.ObjectStorage
	for _, v := range []string{o.Endpoint, o.Region, o.BucketPrefix} {
		if strings.ContainsAny(v, "\r\n") {
			return "", fmt.Errorf("object storage settings cannot contain line breaks")
		}
	}
	return fmt.Sprintf("OBJECT_STORAGE_MODE=external\nOBJECT_STORAGE_ENDPOINT=%s\nOBJECT_STORAGE_REGION=%s\nOBJECT_STORAGE_BUCKET_PREFIX=%s\nOBJECT_STORAGE_FORCE_PATH_STYLE=%s\n", o.Endpoint, o.Region, o.BucketPrefix, strconv.FormatBool(o.ForcePathStyle)), nil
}

// NormalizeObjectStorage trims whitespace and a trailing slash from the endpoint.
func (c *Config) NormalizeObjectStorage() {
	o := &c.ObjectStorage
	o.Mode = strings.ToLower(strings.TrimSpace(o.Mode))
	o.Endpoint = strings.TrimRight(strings.TrimSpace(o.Endpoint), "/")
	o.Region = strings.TrimSpace(o.Region)
	o.BucketPrefix = strings.TrimSpace(o.BucketPrefix)
}

func (c *Config) PromptObjectStorage() {
	askAlways("Object storage (bundled or external)", &c.ObjectStorage.Mode, "bundled")
	if c.ObjectStorageExternal() {
		askAlways("S3 endpoint", &c.ObjectStorage.Endpoint, c.ObjectStorage.Endpoint)
		askAlways("S3 region", &c.ObjectStorage.Region, "us-east-1")
		askAlways("Bucket prefix", &c.ObjectStorage.BucketPrefix, "cairn")
		style := strconv.FormatBool(c.ObjectStorage.ForcePathStyle)
		askAlways("Path-style requests (true, or false for virtual-hosted)", &style, style)
		c.ObjectStorage.ForcePathStyle = style != "false"
		c.ObjectStorage.invalidPathStyle = style != "true" && style != "false"
	}
	c.NormalizeObjectStorage()
}

func (c *Config) PromptObjectStorageCredentials() map[string]string {
	var access, secret string
	askSecretFn("Object storage access key ID", &access)
	askSecretFn("Object storage secret access key", &secret)
	return map[string]string{"OBJECT_STORAGE_ACCESS_KEY": access, "OBJECT_STORAGE_SECRET_KEY": secret}
}
