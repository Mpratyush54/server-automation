package components

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/shell"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/versions"
)

// privateJSON keeps secrets out of shell source and shared temporary files.
func privateJSON(value any) (string, func(), error) {
	data, err := json.Marshal(value)
	if err != nil {
		return "", nil, err
	}
	return privateFile(data)
}
func privateFile(data []byte) (string, func(), error) {
	f, err := os.CreateTemp("", "platformctl-private-*")
	if err != nil {
		return "", nil, err
	}
	cleanup := func() { os.Remove(f.Name()) }
	if _, err = f.Write(data); err != nil {
		f.Close()
		cleanup()
		return "", nil, err
	}
	if err = f.Close(); err != nil {
		cleanup()
		return "", nil, err
	}
	return f.Name(), cleanup, nil
}
func helmValues(release, chartName, namespace string, values any, args ...string) error {
	path, cleanup, err := privateJSON(values)
	if err != nil {
		return err
	}
	defer cleanup()
	argv := []string{"upgrade", "--install", release}
	c := versions.Get(chartName)
	if _, err := os.Stat(c.CacheFile()); err == nil {
		argv = append(argv, c.CacheFile())
	} else {
		argv = append(argv, c.Chart)
		if !c.IsOCI() {
			argv = append(argv, "--repo", c.RepoURL)
		}
		argv = append(argv, "--version", c.Version)
	}
	argv = append(argv, "--namespace", namespace, "--create-namespace", "-f", path)
	return shell.Run("helm", append(argv, args...)...)
}
func applySecret(namespace, name string, values map[string]string) error {
	data, err := json.Marshal(map[string]any{"apiVersion": "v1", "kind": "Secret", "metadata": map[string]string{"name": name, "namespace": namespace}, "type": "Opaque", "stringData": values})
	if err != nil {
		return err
	}
	_, err = shell.RunWithInput("kubectl", []string{"apply", "-f", "-"}, string(data))
	if err != nil {
		return fmt.Errorf("apply secret %s/%s: %w", namespace, name, err)
	}
	return nil
}

func temporaryManifest(name, domain string) (string, error) {
	path, cleanup, err := privateFile(nil)
	if err != nil {
		return "", err
	}
	if err := writeTemplatedManifest(name, domain, path); err != nil {
		cleanup()
		return "", err
	}
	return path, nil
}
