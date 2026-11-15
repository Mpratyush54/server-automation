package config

import (
	"strings"
	"testing"
)

func TestObjectStorageSettings(t *testing.T) {
	c := &Config{}
	c.loadObjectStorage()
	if c.ObjectStorage.Mode != "bundled" || !c.ObjectStorage.ForcePathStyle {
		t.Fatal(c.ObjectStorage)
	}
	c.ObjectStorage = ObjectStorageSettings{Mode: "external", Endpoint: "https://storage.example.com", Region: "auto", BucketPrefix: "cairn", ForcePathStyle: false}
	if err := c.ValidateObjectStorage(); err != nil {
		t.Fatal(err)
	}
	env, err := c.objectStorageEnv()
	if err != nil || !strings.Contains(env, "OBJECT_STORAGE_FORCE_PATH_STYLE=false") || strings.Contains(env, "ACCESS_KEY") {
		t.Fatal(env, err)
	}
	for _, invalid := range []ObjectStorageSettings{
		{Mode: "other"},
		{Mode: "external"},
		{Mode: "external", Endpoint: "https://user:pass@storage.example.com", Region: "auto", BucketPrefix: "cairn"},
		{Mode: "external", Endpoint: "https://storage.example.com/path", Region: "auto", BucketPrefix: "cairn"},
		{Mode: "external", Endpoint: "https://storage.example.com", Region: "auto", BucketPrefix: strings.Repeat("a", 60)},
		{Mode: "external", Endpoint: "https://storage.example.com", Region: "auto", BucketPrefix: "Bad Prefix"},
	} {
		c.ObjectStorage = invalid
		if c.ValidateObjectStorage() == nil {
			t.Errorf("accepted invalid settings: %+v", invalid)
		}
	}
}

func TestExternalStorageOmitsMinioOIDC(t *testing.T) {
	c := &Config{ObjectStorage: ObjectStorageSettings{Mode: "external"}}
	for _, client := range c.OIDCClients() {
		if client.ID == "minio" {
			t.Fatal("MinIO SSO in external mode")
		}
	}
}

func TestObjectStorageRejectsInvalidAddressingSetting(t *testing.T) {
	t.Setenv("OBJECT_STORAGE_FORCE_PATH_STYLE", "invalid")
	c := &Config{}
	c.loadObjectStorage()
	if c.ValidateObjectStorage() == nil {
		t.Fatal("accepted invalid addressing mode")
	}
}

func TestBundledObjectStorageKeepsEnvStable(t *testing.T) {
	c := &Config{}
	c.loadObjectStorage()
	if env, err := c.objectStorageEnv(); err != nil || env != "" {
		t.Fatalf("bundled mode wrote %q (%v)", env, err)
	}
	c.ObjectStorage = ObjectStorageSettings{Mode: " External ", Endpoint: " https://storage.example.com/ ", Region: "auto", BucketPrefix: "cairn", ForcePathStyle: true}
	c.NormalizeObjectStorage()
	env, err := c.objectStorageEnv()
	if err != nil || !strings.Contains(env, "OBJECT_STORAGE_MODE=external\nOBJECT_STORAGE_ENDPOINT=https://storage.example.com\n") {
		t.Fatal(env, err)
	}
}
