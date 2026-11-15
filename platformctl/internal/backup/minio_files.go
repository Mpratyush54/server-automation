package backup

import (
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// The "minio" component: every bucket of the file store except
// platform-backups is copied to objects/<bucket>/<key> with the built-in S3
// client. The layout is the one `mc mirror` produced before #195, so archives
// from older releases restore unchanged.

// Replaceable in tests.
var minioSourceTarget = func(alias string) (S3Target, error) {
	if alias != "" {
		return legacyAliasTarget(alias, "")
	}
	return bundledMinioTarget()
}

// bundledMinioTarget reads the in-cluster MinIO endpoint and root credentials
// from the storage namespace. Credentials stay in memory only.
func bundledMinioTarget() (S3Target, error) {
	ip, err := kubectl("-n", "storage", "get", "svc", "minio", "-o", "jsonpath={.spec.clusterIP}")
	if err != nil || ip == "" || ip == "None" {
		return S3Target{}, fmt.Errorf("bundled MinIO Service not found; provision storage first")
	}
	user, err := kubeSecretDecoded("storage", "minio", "root-user")
	if err != nil || user == "" {
		return S3Target{}, fmt.Errorf("bundled MinIO root user not found")
	}
	pass, err := kubeSecretDecoded("storage", "minio", "root-password")
	if err != nil || pass == "" {
		return S3Target{}, fmt.Errorf("bundled MinIO root password not found")
	}
	host := ip
	if strings.Contains(ip, ":") { // IPv6 ClusterIP
		host = "[" + ip + "]"
	}
	return S3Target{
		Endpoint:  "http://" + host + ":9000",
		Region:    "us-east-1",
		AccessKey: user,
		SecretKey: pass,
	}.Normalize(), nil
}

func kubeSecretDecoded(ns, name, key string) (string, error) {
	b64, err := kubectl("-n", ns, "get", "secret", name, "-o", "jsonpath={.data."+key+"}")
	if err != nil {
		return "", err
	}
	if b64 == "" {
		return "", nil
	}
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return "", fmt.Errorf("decode secret %s/%s.%s: %w", ns, name, key, err)
	}
	return string(raw), nil
}

func captureMinioBuckets(dir, alias string) error {
	ctx := context.Background() // no overall deadline; the client has idle timeouts
	t, err := minioSourceTarget(alias)
	if err != nil {
		return err
	}
	client := NewS3Client(t)
	buckets, err := client.ListBuckets(ctx)
	if err != nil {
		return fmt.Errorf("list MinIO buckets: %w", err)
	}
	objectsDir := filepath.Join(dir, "objects")
	if err := os.MkdirAll(objectsDir, 0700); err != nil {
		return err
	}
	var kept []string
	for _, bucket := range buckets {
		if bucket == "platform-backups" {
			continue
		}
		if !bucketRE.MatchString(bucket) || strings.Contains(bucket, "..") {
			return fmt.Errorf("invalid source bucket %q", bucket)
		}
		dest := filepath.Join(objectsDir, bucket)
		if err := os.MkdirAll(dest, 0700); err != nil {
			return err
		}
		objs, err := client.ListObjects(ctx, bucket, "")
		if err != nil {
			return fmt.Errorf("list objects in %s: %w", bucket, err)
		}
		for _, o := range objs {
			if strings.HasSuffix(o.Key, "/") && o.Size == 0 {
				continue // folder marker
			}
			// A key is a path below dest; refuse anything that could escape it
			// or that has no file-system form, rather than silently skip data.
			if !validObjectPath(o.Key) {
				return fmt.Errorf("cannot back up %s/%q: the object name cannot be stored as a file (empty, '.' or '..' path segments)", bucket, o.Key)
			}
			out := filepath.Join(dest, filepath.FromSlash(o.Key))
			if err := client.GetFile(ctx, bucket, o.Key, out); err != nil {
				return fmt.Errorf("download %s/%s: %w", bucket, o.Key, err)
			}
		}
		kept = append(kept, bucket+"/")
	}
	return os.WriteFile(filepath.Join(dir, "buckets"), []byte(strings.Join(kept, "\n")+"\n"), 0600)
}

func restoreMinioBuckets(dir, alias string) error {
	objectsDir := filepath.Join(dir, "objects")
	entries, err := os.ReadDir(objectsDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	ctx := context.Background()
	t, err := minioSourceTarget(alias)
	if err != nil {
		return err
	}
	client := NewS3Client(t)
	for _, ent := range entries {
		if !ent.IsDir() {
			continue
		}
		bucket := ent.Name()
		if !bucketRE.MatchString(bucket) || strings.Contains(bucket, "..") {
			return fmt.Errorf("invalid restore bucket %q", bucket)
		}
		if err := client.EnsureBucket(ctx, bucket); err != nil {
			return fmt.Errorf("ensure bucket %s: %w", bucket, err)
		}
		root := filepath.Join(objectsDir, bucket)
		err := filepath.WalkDir(root, func(path string, d os.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if d.IsDir() {
				return nil
			}
			if !d.Type().IsRegular() {
				return fmt.Errorf("%s is not a regular file", path)
			}
			rel, err := filepath.Rel(root, path)
			if err != nil {
				return err
			}
			return client.PutFile(ctx, bucket, filepath.ToSlash(rel), path)
		})
		if err != nil {
			return fmt.Errorf("restore bucket %s: %w", bucket, err)
		}
	}
	return nil
}
