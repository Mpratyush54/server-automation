package backup

import (
	"bytes"
	"context"
	"crypto/md5"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Object operations on top of the SigV4 client in target.go: list, put
// (single or multipart), get and delete. Every request body is hashed and the
// hash is signed, so payloads are integrity-protected even on a plain-http
// endpoint (the bundled MinIO on its ClusterIP). Large uploads are streamed in
// fixed-size parts and never held in memory as a whole.

func md5Sum(b []byte) string {
	sum := md5.Sum(b)
	return base64.StdEncoding.EncodeToString(sum[:])
}

// Multipart uploads are used above multipartThreshold. Parts are at least
// multipartPartSize (S3 needs >= 5 MiB except for the last part) and grow for
// very large objects so the upload stays within S3's 10,000-part limit.
// Vars (not consts) so unit tests can shrink them without large fixtures.
var (
	multipartThreshold int64 = 64 << 20 // 64 MiB
	multipartPartSize  int64 = 16 << 20 // 16 MiB
)

const maxMultipartParts = 10000

// partSizeFor returns the part size for an object of size bytes (-1 unknown).
func partSizeFor(size int64) int64 {
	ps := multipartPartSize
	if size > 0 {
		if need := (size + maxMultipartParts - 1) / maxMultipartParts; need > ps {
			const mib = 1 << 20
			ps = (need + mib - 1) / mib * mib
		}
	}
	return ps
}

// ObjectInfo is one object from a ListObjectsV2 page.
type ObjectInfo struct {
	Key  string
	Size int64
}

// PutObject uploads body to bucket/key. Objects of known size up to
// multipartThreshold go in one signed PUT (a seekable body is hashed and
// rewound; anything else is read into memory, at most multipartThreshold
// bytes). Larger or unknown-size bodies use a multipart upload, read one part
// at a time.
func (c *S3Client) PutObject(ctx context.Context, bucket, key string, body io.Reader, size int64) error {
	if size >= 0 && size <= multipartThreshold {
		return c.putSingle(ctx, bucket, key, body, size)
	}
	return c.putMultipart(ctx, bucket, key, body, size)
}

// PutFile uploads a local file.
func (c *S3Client) PutFile(ctx context.Context, bucket, key, path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return err
	}
	return c.PutObject(ctx, bucket, key, f, st.Size())
}

func (c *S3Client) putSingle(ctx context.Context, bucket, key string, body io.Reader, size int64) error {
	var hash string
	if rs, ok := body.(io.ReadSeeker); ok {
		start, err := rs.Seek(0, io.SeekCurrent)
		if err != nil {
			return err
		}
		h := sha256.New()
		n, err := io.Copy(h, io.LimitReader(rs, size+1))
		if err != nil {
			return err
		}
		if n != size {
			return fmt.Errorf("upload of %s changed size while reading (%d, expected %d bytes)", key, n, size)
		}
		if _, err = rs.Seek(start, io.SeekStart); err != nil {
			return err
		}
		hash = hex.EncodeToString(h.Sum(nil))
		// LimitReader also hides the file's Close from the HTTP transport.
		body = io.LimitReader(rs, size)
	} else {
		b, err := io.ReadAll(io.LimitReader(body, size+1))
		if err != nil {
			return err
		}
		if int64(len(b)) != size {
			return fmt.Errorf("upload of %s has %d bytes, expected %d", key, len(b), size)
		}
		hash, body = sha256Hex(b), bytes.NewReader(b)
	}
	resp, err := c.doRequest(ctx, c.transferHTTP(), http.MethodPut, bucket, key, nil, body, size, hash)
	if err != nil {
		return c.s3Error("write to", 0, nil, err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode/100 != 2 {
		return c.s3Error("write to", resp.StatusCode, b, nil)
	}
	return nil
}

type completedPart struct {
	XMLName    xml.Name `xml:"Part"`
	PartNumber int      `xml:"PartNumber"`
	ETag       string   `xml:"ETag"`
}

func (c *S3Client) putMultipart(ctx context.Context, bucket, key string, body io.Reader, size int64) (err error) {
	uploadID, err := c.createMultipart(ctx, bucket, key)
	if err != nil {
		return err
	}
	// Abort on every failure so no incomplete upload (and its stored parts)
	// is left behind. A fresh context: the caller's may already be cancelled.
	completed := false
	defer func() {
		if !completed {
			actx, cancel := context.WithTimeout(context.Background(), time.Minute)
			defer cancel()
			if ae := c.abortMultipart(actx, bucket, key, uploadID); ae != nil {
				err = fmt.Errorf("%w (and aborting the incomplete upload failed: %v)", err, ae)
			}
		}
	}()
	buf := make([]byte, partSizeFor(size))
	var parts []completedPart
	var total int64
	for partNum := 1; ; partNum++ {
		n, readErr := io.ReadFull(body, buf)
		if readErr != nil && readErr != io.EOF && readErr != io.ErrUnexpectedEOF {
			return readErr
		}
		if n == 0 && partNum > 1 {
			break
		}
		if partNum > maxMultipartParts {
			return fmt.Errorf("upload of %s needs more than %d parts", key, maxMultipartParts)
		}
		etag, upErr := c.uploadPart(ctx, bucket, key, uploadID, partNum, buf[:n])
		if upErr != nil {
			return upErr
		}
		parts = append(parts, completedPart{PartNumber: partNum, ETag: etag})
		total += int64(n)
		if readErr != nil { // short read: that was the last part
			break
		}
	}
	if size >= 0 && total != size {
		return fmt.Errorf("upload of %s changed size while reading (%d, expected %d bytes)", key, total, size)
	}
	if err = c.completeMultipart(ctx, bucket, key, uploadID, parts); err != nil {
		return err
	}
	completed = true
	return nil
}

func (c *S3Client) createMultipart(ctx context.Context, bucket, key string) (string, error) {
	q := url.Values{"uploads": {""}}
	st, b, err := c.doBucket(ctx, http.MethodPost, bucket, key, q, nil)
	if err != nil || st/100 != 2 {
		return "", c.s3Error("write to", st, b, err)
	}
	var r struct {
		UploadID string `xml:"UploadId"`
	}
	if err := xml.Unmarshal(b, &r); err != nil || r.UploadID == "" {
		return "", fmt.Errorf("the backup target returned an unreadable multipart upload id")
	}
	return r.UploadID, nil
}

// uploadPart sends one part with a signed SHA-256 and a Content-MD5, so the
// store verifies the bytes it received.
func (c *S3Client) uploadPart(ctx context.Context, bucket, key, uploadID string, partNumber int, part []byte) (string, error) {
	q := url.Values{"partNumber": {fmt.Sprintf("%d", partNumber)}, "uploadId": {uploadID}}
	u, err := c.objectURL(bucket, key, q)
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, u.String(), bytes.NewReader(part))
	if err != nil {
		return "", err
	}
	req.ContentLength = int64(len(part))
	req.Header.Set("Content-MD5", md5Sum(part))
	Sign(req, part, c.Target.AccessKey, c.Target.SecretKey, c.Target.SigningRegion(), c.Now())
	resp, err := c.transferHTTP().Do(req)
	if err != nil {
		return "", c.s3Error("write to", 0, nil, err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode/100 != 2 {
		return "", c.s3Error("write to", resp.StatusCode, b, nil)
	}
	etag := resp.Header.Get("ETag")
	if etag == "" {
		return "", fmt.Errorf("the backup target did not return an ETag for multipart part %d", partNumber)
	}
	// CompleteMultipartUpload takes the ETag exactly as returned (with quotes).
	return etag, nil
}

func (c *S3Client) completeMultipart(ctx context.Context, bucket, key, uploadID string, parts []completedPart) error {
	var body struct {
		XMLName xml.Name        `xml:"CompleteMultipartUpload"`
		Parts   []completedPart `xml:"Part"`
	}
	body.Parts = parts
	payload, err := xml.Marshal(body)
	if err != nil {
		return err
	}
	q := url.Values{"uploadId": {uploadID}}
	resp, err := c.doRequest(ctx, c.transferHTTP(), http.MethodPost, bucket, key, q, bytes.NewReader(payload), int64(len(payload)), sha256Hex(payload))
	if err != nil {
		return c.s3Error("write to", 0, nil, err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode/100 != 2 {
		return c.s3Error("write to", resp.StatusCode, b, nil)
	}
	// S3 can answer 200 OK and still fail: the error is then in the body.
	var root struct{ XMLName xml.Name }
	if xml.Unmarshal(b, &root) == nil && root.XMLName.Local == "Error" {
		return c.s3Error("write to", http.StatusInternalServerError, b, nil)
	}
	return nil
}

func (c *S3Client) abortMultipart(ctx context.Context, bucket, key, uploadID string) error {
	q := url.Values{"uploadId": {uploadID}}
	st, b, err := c.doBucket(ctx, http.MethodDelete, bucket, key, q, nil)
	if err != nil || (st/100 != 2 && st != http.StatusNotFound) {
		return c.s3Error("delete from", st, b, err)
	}
	return nil
}

// GetObject streams bucket/key to w.
func (c *S3Client) GetObject(ctx context.Context, bucket, key string, w io.Writer) error {
	resp, err := c.doRequest(ctx, c.transferHTTP(), http.MethodGet, bucket, key, nil, nil, -1, sha256Hex(nil))
	if err != nil {
		return c.s3Error("read back from", 0, nil, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		return c.s3Error("read back from", resp.StatusCode, b, nil)
	}
	n, err := io.Copy(w, resp.Body)
	if err != nil {
		return fmt.Errorf("download of %s interrupted: %w", key, err)
	}
	if resp.ContentLength >= 0 && n != resp.ContentLength {
		return fmt.Errorf("download of %s is incomplete (%d of %d bytes)", key, n, resp.ContentLength)
	}
	return nil
}

// GetFile downloads bucket/key to a local file (mode 0600). A failed download
// leaves no partial file behind.
func (c *S3Client) GetFile(ctx context.Context, bucket, key, path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	err = c.GetObject(ctx, bucket, key, f)
	if ce := f.Close(); err == nil {
		err = ce
	}
	if err != nil {
		_ = os.Remove(path)
	}
	return err
}

// DeleteObject removes one object. Missing objects are treated as success.
func (c *S3Client) DeleteObject(ctx context.Context, bucket, key string) error {
	st, b, err := c.doBucket(ctx, http.MethodDelete, bucket, key, nil, nil)
	if err != nil {
		return c.s3Error("delete from", st, b, err)
	}
	if st/100 == 2 || st == http.StatusNotFound {
		return nil
	}
	return c.s3Error("delete from", st, b, nil)
}

// maxDeleteKeys is S3's DeleteObjects limit per request.
const maxDeleteKeys = 1000

// DeleteObjects removes keys in batches of at most 1000 (S3's limit).
func (c *S3Client) DeleteObjects(ctx context.Context, bucket string, keys []string) error {
	for start := 0; start < len(keys); start += maxDeleteKeys {
		end := min(start+maxDeleteKeys, len(keys))
		if err := c.deleteObjectsBatch(ctx, bucket, keys[start:end]); err != nil {
			return err
		}
	}
	return nil
}

func (c *S3Client) deleteObjectsBatch(ctx context.Context, bucket string, keys []string) error {
	type obj struct {
		Key string `xml:"Key"`
	}
	var body struct {
		XMLName xml.Name `xml:"Delete"`
		Quiet   bool     `xml:"Quiet"`
		Objects []obj    `xml:"Object"`
	}
	body.Quiet = true
	for _, k := range keys {
		body.Objects = append(body.Objects, obj{Key: k})
	}
	payload, err := xml.Marshal(body)
	if err != nil {
		return err
	}
	u, err := c.objectURL(bucket, "", url.Values{"delete": {""}})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u.String(), bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.ContentLength = int64(len(payload))
	// S3 requires Content-MD5 (or a checksum header) on DeleteObjects.
	req.Header.Set("Content-MD5", md5Sum(payload))
	req.Header.Set("Content-Type", "application/xml")
	Sign(req, payload, c.Target.AccessKey, c.Target.SecretKey, c.Target.SigningRegion(), c.Now())
	resp, err := c.httpClient().Do(req)
	if err != nil {
		return c.s3Error("delete from", 0, nil, err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode/100 != 2 {
		return c.s3Error("delete from", resp.StatusCode, b, nil)
	}
	// In quiet mode the 200 response lists only the keys that failed.
	var r struct {
		Errors []struct{ Key, Code string } `xml:"Error"`
	}
	if xml.Unmarshal(b, &r) == nil && len(r.Errors) > 0 {
		e := r.Errors[0]
		return fmt.Errorf("cannot delete from the backup target %s: %d of %d objects were not deleted (first: %s: %s)", c.Target.Describe(), len(r.Errors), len(keys), e.Key, e.Code)
	}
	return nil
}

// DeletePrefix lists every object under prefix and deletes them in batches.
func (c *S3Client) DeletePrefix(ctx context.Context, bucket, prefix string) error {
	objs, err := c.ListObjects(ctx, bucket, prefix)
	if err != nil {
		return err
	}
	keys := make([]string, 0, len(objs))
	for _, o := range objs {
		keys = append(keys, o.Key)
	}
	return c.DeleteObjects(ctx, bucket, keys)
}

// ListObjects returns every object under prefix (paginated ListObjectsV2).
func (c *S3Client) ListObjects(ctx context.Context, bucket, prefix string) ([]ObjectInfo, error) {
	var out []ObjectInfo
	token := ""
	for {
		q := url.Values{"list-type": {"2"}, "prefix": {prefix}}
		if token != "" {
			q.Set("continuation-token", token)
		}
		st, b, err := c.doBucket(ctx, http.MethodGet, bucket, "", q, nil)
		if err != nil || st/100 != 2 {
			return nil, c.s3Error("list", st, b, err)
		}
		var r struct {
			Contents []struct {
				Key  string
				Size int64
			}
			IsTruncated bool
			NextToken   string `xml:"NextContinuationToken"`
		}
		if err := xml.Unmarshal(b, &r); err != nil {
			return nil, fmt.Errorf("the backup target returned an unreadable listing")
		}
		for _, o := range r.Contents {
			if o.Key != "" {
				out = append(out, ObjectInfo{Key: o.Key, Size: o.Size})
			}
		}
		if !r.IsTruncated {
			return out, nil
		}
		if r.NextToken == "" || r.NextToken == token {
			return nil, fmt.Errorf("the backup target returned a truncated listing without a new continuation token")
		}
		token = r.NextToken
	}
}

// ListBuckets returns bucket names on the endpoint (ListAllMyBuckets).
func (c *S3Client) ListBuckets(ctx context.Context) ([]string, error) {
	st, b, err := c.doBucket(ctx, http.MethodGet, "", "", nil, nil)
	if err != nil || st/100 != 2 {
		return nil, c.s3Error("list", st, b, err)
	}
	var r struct {
		Buckets struct {
			Bucket []struct{ Name string }
		}
	}
	if err := xml.Unmarshal(b, &r); err != nil {
		return nil, fmt.Errorf("the backup target returned an unreadable bucket listing")
	}
	var out []string
	for _, bk := range r.Buckets.Bucket {
		if bk.Name != "" {
			out = append(out, bk.Name)
		}
	}
	return out, nil
}

// EnsureBucket creates bucket unless it already exists. An existing bucket
// (HEAD answers 2xx) needs no CreateBucket permission, so operators can
// pre-create buckets; any HEAD answer other than 404 is reported, so an
// authorization failure is never mistaken for a missing bucket. Outside
// us-east-1 (and R2's "auto") the create request names the region, as AWS
// requires.
func (c *S3Client) EnsureBucket(ctx context.Context, bucket string) error {
	st, b, err := c.doBucket(ctx, http.MethodHead, bucket, "", nil, nil)
	if err == nil && st/100 == 2 {
		return nil
	}
	if err != nil || st != http.StatusNotFound {
		return c.s3Error("check bucket "+bucket+" on", st, b, err)
	}
	var body []byte
	if region := c.Target.SigningRegion(); region != "us-east-1" && region != "auto" {
		body, err = xml.Marshal(struct {
			XMLName  xml.Name `xml:"CreateBucketConfiguration"`
			XMLNS    string   `xml:"xmlns,attr"`
			Location string   `xml:"LocationConstraint"`
		}{XMLNS: "http://s3.amazonaws.com/doc/2006-03-01/", Location: region})
		if err != nil {
			return err
		}
	}
	st, b, err = c.doBucket(ctx, http.MethodPut, bucket, "", nil, body)
	if err != nil {
		return c.s3Error("write to", st, b, err)
	}
	if st/100 == 2 {
		return nil
	}
	var e struct{ Code string }
	_ = xml.Unmarshal(b, &e)
	if e.Code == "BucketAlreadyOwnedByYou" {
		return nil
	}
	if e.Code == "BucketAlreadyExists" {
		return fmt.Errorf("bucket %q already exists and belongs to another account", bucket)
	}
	return c.s3Error("write to", st, b, nil)
}

// validObjectPath reports whether an object key maps to a safe relative file
// path below the bucket directory: not absolute, no empty, "." or ".."
// segments, no NUL.
func validObjectPath(key string) bool {
	if key == "" || strings.HasPrefix(key, "/") || strings.HasSuffix(key, "/") || strings.ContainsRune(key, 0) {
		return false
	}
	for _, seg := range strings.Split(key, "/") {
		if seg == "" || seg == "." || seg == ".." {
			return false
		}
	}
	return true
}
