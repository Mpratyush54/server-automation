package k3s

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// imageRegistryAuthPath holds the image registry credentials (0600).
var imageRegistryAuthPath = "/etc/rancher/k3s/cairn-image-registry.json"

// ImageRegistryAuth is a registry login rendered into registries.yaml.
type ImageRegistryAuth struct {
	Registry string `json:"registry"`
	Username string `json:"username"`
	Password string `json:"password"`
}

// Validate rejects values that cannot be rendered safely.
func (a ImageRegistryAuth) Validate() error {
	host := a.Registry
	if host == "" || strings.ContainsAny(host, "/\\\"' \t\r\n") || a.Username == "" || a.Password == "" ||
		strings.ContainsAny(a.Username+a.Password, "\r\n") {
		return fmt.Errorf("invalid registry credentials")
	}
	return nil
}

func readImageRegistryAuth() *ImageRegistryAuth {
	data, err := os.ReadFile(imageRegistryAuthPath)
	if err != nil {
		return nil
	}
	var a ImageRegistryAuth
	if json.Unmarshal(data, &a) != nil || a.Validate() != nil {
		return nil
	}
	return &a
}

// ReadImageRegistryAuth returns the stored credentials, if any.
func ReadImageRegistryAuth() (ImageRegistryAuth, bool) {
	if a := readImageRegistryAuth(); a != nil {
		return *a, true
	}
	return ImageRegistryAuth{}, false
}

// WriteImageRegistryAuth stores the credentials and rewrites registries.yaml.
// It reports whether registries.yaml changed.
func WriteImageRegistryAuth(githubToken string, a ImageRegistryAuth) (bool, error) {
	if err := StoreImageRegistryAuth(a); err != nil {
		return false, err
	}
	return WriteRegistries(githubToken)
}

// StoreImageRegistryAuth stores the credentials without rewriting registries.yaml.
func StoreImageRegistryAuth(a ImageRegistryAuth) error {
	if err := a.Validate(); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(imageRegistryAuthPath), 0o755); err != nil {
		return err
	}
	data, _ := json.Marshal(a)
	return os.WriteFile(imageRegistryAuthPath, data, 0o600)
}
