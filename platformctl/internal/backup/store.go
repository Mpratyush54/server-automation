package backup

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// Store publishes backup.json last: an interrupted upload is never listed or
// eligible for retention. Targets must be dedicated prefixes, never bucket roots
// containing unrelated data. Remote (s3://) transfers use the built-in S3 client
// with credentials from UseExternalTarget.
type Store struct{ Target Target }

// externalS3 holds credentials for the configured off-site target. It is set by
// UseExternalTarget and used only by Store remote operations.
var externalS3 *S3Target

// UseExternalTarget makes the configured backup target available for archive
// put/get/list/delete through the built-in S3 client.
func UseExternalTarget(t S3Target) {
	t = t.Normalize()
	externalS3 = &t
}

func copyFile(src, dst string) error {
	in, e := os.Open(src)
	if e != nil {
		return e
	}
	defer in.Close()
	if e = os.MkdirAll(filepath.Dir(dst), 0700); e != nil {
		return e
	}
	out, e := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if e != nil {
		return e
	}
	_, e = io.Copy(out, in)
	ce := out.Close()
	if e != nil {
		return e
	}
	return ce
}

func (s Store) object(id, file string) (string, error) {
	if !safeName.MatchString(id) || !safeName.MatchString(file) {
		return "", fmt.Errorf("invalid backup object name")
	}
	return s.Target.Path + "/" + id + "/" + file, nil
}

// remoteRef resolves an s3 Store path (alias/bucket[/prefix...]/id/file) into
// a client, bucket and object key. The alias "platformtarget" is the
// configured off-site target (UseExternalTarget); any other alias is an mc
// alias from an older configuration (see mc_compat.go).
func (s Store) remoteRef(id, file string) (*S3Client, string, string, error) {
	p, err := s.object(id, file)
	if err != nil {
		return nil, "", "", err
	}
	return resolveRemote(p)
}

func resolveRemote(fullPath string) (*S3Client, string, string, error) {
	parts := strings.Split(strings.Trim(fullPath, "/"), "/")
	if len(parts) < 2 {
		return nil, "", "", fmt.Errorf("invalid S3 target path")
	}
	alias, bucket, key := parts[0], parts[1], strings.Join(parts[2:], "/")
	if alias == MCAlias && externalS3 != nil {
		if bucket != externalS3.Bucket {
			return nil, "", "", fmt.Errorf("S3 target bucket %q does not match the configured backup target bucket %q", bucket, externalS3.Bucket)
		}
		return NewS3Client(*externalS3), bucket, key, nil
	}
	// s3://<mc alias>/... from a configuration written before #195.
	t, err := legacyTarget(alias, bucket)
	if err != nil {
		if alias == MCAlias {
			return nil, "", "", fmt.Errorf("the off-site backup target's credentials are not loaded; set \"target\": \"external\" in backup.json (or pass --target external)")
		}
		return nil, "", "", err
	}
	return NewS3Client(t), bucket, key, nil
}

// legacyTargets caches resolved mc aliases for this process.
var legacyTargets = map[string]S3Target{}

func legacyTarget(alias, bucket string) (S3Target, error) {
	id := alias + "/" + bucket
	if t, ok := legacyTargets[id]; ok {
		return t, nil
	}
	t, err := legacyAliasTarget(alias, bucket)
	if err != nil {
		return S3Target{}, err
	}
	legacyTargets[id] = t
	return t, nil
}

// ctx is the context for archive transfers: no overall deadline (a large
// archive on a slow link may take hours); the client's dial, header and idle
// timeouts catch a dead connection.
func (s Store) ctx() (context.Context, context.CancelFunc) {
	return context.WithCancel(context.Background())
}

func (s Store) Put(id, file, src string) error {
	if !s.Target.Remote {
		p, e := s.object(id, file)
		if e != nil {
			return e
		}
		return copyFile(src, p)
	}
	client, bucket, key, err := s.remoteRef(id, file)
	if err != nil {
		return err
	}
	ctx, cancel := s.ctx()
	defer cancel()
	return client.PutFile(ctx, bucket, key, src)
}

func (s Store) Get(id, file, dst string) error {
	if !s.Target.Remote {
		p, e := s.object(id, file)
		if e != nil {
			return e
		}
		return copyFile(p, dst)
	}
	client, bucket, key, err := s.remoteRef(id, file)
	if err != nil {
		return err
	}
	ctx, cancel := s.ctx()
	defer cancel()
	return client.GetFile(ctx, bucket, key, dst)
}

// CleanupLog receives best-effort cleanup failures; a variable for tests.
var CleanupLog io.Writer = os.Stderr

// remove deletes one object of a backup.
func (s Store) remove(id, file string) error {
	if !s.Target.Remote {
		p, e := s.object(id, file)
		if e != nil {
			return e
		}
		e = os.Remove(p)
		if e != nil && !os.IsNotExist(e) {
			return e
		}
		return nil
	}
	client, bucket, key, err := s.remoteRef(id, file)
	if err != nil {
		return err
	}
	ctx, cancel := s.ctx()
	defer cancel()
	return client.DeleteObject(ctx, bucket, key)
}

// discard removes the objects of a backup that failed before backup.json was
// published (best effort). uploaded were stored; attempted (may be "") is
// the object whose upload failed and may or may not exist, so an error
// removing it is not reported.
func (s Store) discard(id string, uploaded []string, attempted string) {
	failed := 0
	for _, f := range uploaded {
		if e := s.remove(id, f); e != nil {
			failed++
		}
	}
	if attempted != "" {
		_ = s.remove(id, attempted)
	}
	if !s.Target.Remote {
		_ = os.Remove(filepath.Join(s.Target.Path, id))
	}
	if failed > 0 {
		fmt.Fprintf(CleanupLog, "backup %s failed and %d of its uploaded files could not be removed from the target; the incomplete folder %s/ is not restorable and can be deleted\n", id, failed, id)
	}
}

// List returns the complete backups (those with backup.json).
func (s Store) List() ([]Manifest, error) {
	items, _, e := s.ListWithIncomplete()
	return items, e
}

// ListWithIncomplete also returns the IDs of folders without a readable
// backup.json: a backup that failed or was interrupted, or one still being
// uploaded. They are never restorable or eligible for retention.
func (s Store) ListWithIncomplete() ([]Manifest, []string, error) {
	var ids []string
	if s.Target.Remote {
		client, _, prefix, err := resolveRemote(s.Target.Path)
		if err != nil {
			return nil, nil, err
		}
		ctx, cancel := s.ctx()
		defer cancel()
		folders, err := client.ListFolders(ctx, prefix)
		if err != nil {
			return nil, nil, err
		}
		ids = folders
	} else {
		entries, e := os.ReadDir(s.Target.Path)
		if os.IsNotExist(e) {
			return nil, nil, nil
		}
		if e != nil {
			return nil, nil, e
		}
		for _, v := range entries {
			if v.IsDir() {
				ids = append(ids, v.Name())
			}
		}
	}
	tmp, e := os.MkdirTemp("", "platform-backup-list-")
	if e != nil {
		return nil, nil, e
	}
	defer os.RemoveAll(tmp)
	var result []Manifest
	var incomplete []string
	for _, id := range ids {
		if !safeName.MatchString(id) {
			continue
		}
		f := filepath.Join(tmp, "backup.json")
		if e = s.Get(id, "backup.json", f); e != nil {
			incomplete = append(incomplete, id)
			continue
		}
		m, e := ReadManifest(f)
		if e != nil {
			return nil, nil, fmt.Errorf("backup %s: %w", id, e)
		}
		if m.ID != id {
			return nil, nil, fmt.Errorf("manifest ID mismatch")
		}
		result = append(result, m)
	}
	return result, incomplete, nil
}

func (s Store) Retain(r Retention) error {
	items, e := s.List()
	if e != nil {
		return e
	}
	ids, e := Prune(items, r)
	if e != nil {
		return e
	}
	for _, id := range ids {
		// Remove only manifest-declared objects, never recursively delete a target.
		for _, m := range items {
			if m.ID != id {
				continue
			}
			files := []string{}
			for _, a := range m.Artifacts {
				files = append(files, a.File)
			}
			files = append(files, "backup.json")
			for _, f := range files {
				if e := s.remove(id, f); e != nil {
					return e
				}
			}
			if !s.Target.Remote {
				_ = os.Remove(filepath.Join(s.Target.Path, id))
			}
		}
	}
	return nil
}
