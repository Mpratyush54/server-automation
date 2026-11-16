package cmd

import (
	"bufio"
	"fmt"
	"io"
	"strings"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/components"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/state"
)

var objectCredentials map[string]string
var objectCredentialsStdin bool
var objectModeFlag, objectEndpointFlag, objectRegionFlag, objectPrefixFlag string
var objectPathStyleFlag bool
var objectPathStyleChanged = func() bool { return false }
var prepareObjectStorage = components.PrepareObjectStorage

// checkObjectStorageFlags runs before any interactive prompt: prompts read
// stdin too, so they would consume the credential lines.
func checkObjectStorageFlags(c *config.Config) error {
	if objectCredentialsStdin && !c.NonInteractive {
		return fmt.Errorf("--object-storage-credentials-stdin needs --auto (interactive prompts also read stdin)")
	}
	return nil
}

func resolveObjectStorage(c *config.Config, input io.Reader) error {
	saved := c.ObjectStorage.Mode
	if saved == "" {
		saved = "bundled"
	}
	for _, setting := range []struct {
		value string
		dst   *string
	}{
		{objectModeFlag, &c.ObjectStorage.Mode}, {objectEndpointFlag, &c.ObjectStorage.Endpoint},
		{objectRegionFlag, &c.ObjectStorage.Region}, {objectPrefixFlag, &c.ObjectStorage.BucketPrefix},
	} {
		if setting.value != "" {
			*setting.dst = setting.value
		}
	}
	if objectPathStyleChanged() {
		c.ObjectStorage.ForcePathStyle = objectPathStyleFlag
	}
	c.NormalizeObjectStorage()
	installed := state.IsDone("platform")
	if c.IsHA() && !c.NonInteractive && objectModeFlag == "" && !installed {
		c.PromptObjectStorage()
	}
	if err := c.ValidateObjectStorage(); err != nil {
		return err
	}
	mode := c.ObjectStorage.Mode
	if mode == "" {
		mode = "bundled"
	}
	if installed && mode != saved {
		return fmt.Errorf("object storage mode cannot change from %s to %s on an existing install; moving data between bundled MinIO and external S3 is not supported", saved, mode)
	}
	if !c.ObjectStorageExternal() {
		return nil
	}
	if state.IsDone("minio") {
		return fmt.Errorf("external object storage supports fresh installs only; migration from bundled MinIO is not supported")
	}
	objectCredentials = nil
	if objectCredentialsStdin {
		var err error
		objectCredentials, err = readObjectCredentials(input)
		if err != nil {
			return err
		}
	} else {
		var err error
		objectCredentials, err = components.ReadObjectStorageCredentials()
		if err != nil && !c.NonInteractive {
			objectCredentials = c.PromptObjectStorageCredentials()
			err = nil
		}
		if err != nil {
			return fmt.Errorf("external object storage needs --object-storage-credentials-stdin (two lines: access key ID, secret access key), or Secret platform/platform-object-storage")
		}
	}
	return prepareObjectStorage(c, objectCredentials)
}

func readObjectCredentials(input io.Reader) (map[string]string, error) {
	s := bufio.NewScanner(io.LimitReader(input, 16<<10))
	lines := []string{}
	for s.Scan() && len(lines) < 3 {
		lines = append(lines, strings.TrimSpace(s.Text()))
	}
	if s.Err() != nil || len(lines) != 2 || lines[0] == "" || lines[1] == "" {
		return nil, fmt.Errorf("--object-storage-credentials-stdin expects two non-empty lines: access key ID, then secret access key")
	}
	return map[string]string{"OBJECT_STORAGE_ACCESS_KEY": lines[0], "OBJECT_STORAGE_SECRET_KEY": lines[1]}, nil
}

func init() {
	f := provisionCmd.Flags()
	objectPathStyleChanged = func() bool { return f.Changed("object-storage-force-path-style") }
	f.StringVar(&objectModeFlag, "object-storage-mode", "", "object storage mode: bundled or external (fresh installs only)")
	f.StringVar(&objectEndpointFlag, "object-storage-endpoint", "", "external S3 endpoint URL")
	f.StringVar(&objectRegionFlag, "object-storage-region", "", "external S3 region")
	f.StringVar(&objectPrefixFlag, "object-storage-bucket-prefix", "", "external bucket prefix (<prefix>-<purpose>)")
	f.BoolVar(&objectPathStyleFlag, "object-storage-force-path-style", true, "use path-style S3 requests")
	f.BoolVar(&objectCredentialsStdin, "object-storage-credentials-stdin", false, "read object storage access key ID and secret access key from two lines on stdin")
}

// External objects remain under the provider's retention/replication policy.
func objectBackupComponents(c *config.Config, components []string) []string {
	if !c.ObjectStorageExternal() {
		return components
	}
	out := []string{}
	for _, name := range components {
		if name != "minio" {
			out = append(out, name)
		}
	}
	return out
}
