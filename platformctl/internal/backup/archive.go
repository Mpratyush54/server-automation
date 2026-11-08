package backup

import (
	"archive/tar"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"filippo.io/age"
)

func ValidateRecipient(s string) error { _, e := age.ParseX25519Recipient(s); return e }

func EncryptDirectory(dir, dest, recipient string) (err error) {
	r, err := age.ParseX25519Recipient(recipient)
	if err != nil {
		return err
	}
	f, err := os.OpenFile(dest, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer func() {
		if e := f.Close(); err == nil {
			err = e
		}
	}()
	w, err := age.Encrypt(f, r)
	if err != nil {
		return err
	}
	tw := tar.NewWriter(w)
	err = filepath.Walk(dir, func(p string, info os.FileInfo, e error) error {
		if e != nil {
			return e
		}
		if info.IsDir() {
			return nil
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("non-regular backup file")
		}
		rel, e := filepath.Rel(dir, p)
		if e != nil {
			return e
		}
		h, e := tar.FileInfoHeader(info, "")
		if e != nil {
			return e
		}
		h.Name = filepath.ToSlash(rel)
		h.Mode = 0600
		h.Uid = 0
		h.Gid = 0
		h.Uname = ""
		h.Gname = ""
		if e = tw.WriteHeader(h); e != nil {
			return e
		}
		in, e := os.Open(p)
		if e != nil {
			return e
		}
		defer in.Close()
		_, e = io.Copy(tw, in)
		return e
	})
	if err != nil {
		return err
	}
	if err = tw.Close(); err != nil {
		return err
	}
	return w.Close()
}

// DecryptDirectory accepts only ordinary files beneath a private empty staging
// directory. Callers verify ciphertext checksums before invoking it.
func DecryptDirectory(src, dir string, identity io.Reader) error {
	ids, e := age.ParseIdentities(identity)
	if e != nil {
		return e
	}
	if len(ids) == 0 {
		return fmt.Errorf("missing age identity")
	}
	f, e := os.Open(src)
	if e != nil {
		return e
	}
	defer f.Close()
	r, e := age.Decrypt(f, ids...)
	if e != nil {
		return e
	}
	tr := tar.NewReader(r)
	for {
		h, e := tr.Next()
		if e == io.EOF { // Consume the age stream to authenticate its final chunk.
			_, e = io.Copy(io.Discard, r)
			return e
		}
		if e != nil {
			return e
		}
		name := filepath.FromSlash(h.Name)
		// Validate the slash-separated archive name itself (a leading "/" is not
		// "absolute" to filepath on Windows), then the OS-specific form.
		if h.Typeflag != tar.TypeReg || strings.HasPrefix(h.Name, "/") || strings.Contains(h.Name, "\\") || strings.Contains(h.Name, ":") || !filepath.IsLocal(name) {
			return fmt.Errorf("unsafe archive entry")
		}
		p := filepath.Join(dir, name)
		if e = os.MkdirAll(filepath.Dir(p), 0700); e != nil {
			return e
		}
		out, e := os.OpenFile(p, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if e != nil {
			return e
		}
		_, e = io.Copy(out, tr)
		ce := out.Close()
		if e != nil {
			return e
		}
		if ce != nil {
			return ce
		}
	}
}
