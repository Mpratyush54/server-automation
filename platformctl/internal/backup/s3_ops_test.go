package backup

import (
	"bytes"
	"context"
	"crypto/md5"
	"encoding/base64"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

// richFakeS3 is a path-style store that supports list pagination, multipart,
// single-object CRUD and DeleteObjects.
type richFakeS3 struct {
	mu        sync.Mutex
	objects   map[string][]byte // "bucket/key" -> body
	uploads   map[string]map[int][]byte
	uploadIDs int
	maxKeys   int // ListObjectsV2 page size (0 = unlimited)
	failPart  int // fail UploadPart with this part number (0 = none)

	completeErr  bool            // CompleteMultipartUpload answers 200 with an <Error> body
	deleteFail   string          // DeleteObjects reports this key as failed
	deleteSizes  []int           // number of keys in each DeleteObjects request
	noToken      bool            // truncated listings without NextContinuationToken
	partMD5s     int             // UploadPart requests carrying a correct Content-MD5
	bodyRequests []string        // "METHOD key" of every request that had a body
	created      map[string]bool // buckets made by CreateBucket
}

func newRichFakeS3() *richFakeS3 {
	return &richFakeS3{objects: map[string][]byte{}, uploads: map[string]map[int][]byte{}, maxKeys: 2}
}

func (f *richFakeS3) key(bucket, obj string) string { return bucket + "/" + obj }

func (f *richFakeS3) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !strings.HasPrefix(r.Header.Get("Authorization"), "AWS4-HMAC-SHA256 Credential=AK/") {
		w.WriteHeader(403)
		io.WriteString(w, "<Error><Code>SignatureDoesNotMatch</Code></Error>")
		return
	}
	// S3 rejects chunked uploads without a decoded length, and the signed
	// payload hash must match the bytes received.
	if len(r.TransferEncoding) > 0 {
		w.WriteHeader(501)
		io.WriteString(w, "<Error><Code>NotImplemented</Code></Error>")
		return
	}
	var reqBody []byte
	if r.Body != nil {
		reqBody, _ = io.ReadAll(r.Body)
		r.Body = io.NopCloser(bytes.NewReader(reqBody))
	}
	if got := r.Header.Get("x-amz-content-sha256"); got != sha256Hex(reqBody) {
		w.WriteHeader(400)
		io.WriteString(w, "<Error><Code>XAmzContentSHA256Mismatch</Code></Error>")
		return
	}
	if len(reqBody) > 0 {
		f.bodyRequests = append(f.bodyRequests, r.Method+" "+r.URL.Path)
	}
	path := strings.TrimPrefix(r.URL.Path, "/")
	q := r.URL.Query()

	// ListBuckets
	if path == "" && r.Method == http.MethodGet {
		io.WriteString(w, `<ListAllMyBucketsResult><Buckets>`)
		seen := map[string]bool{}
		for k := range f.objects {
			b := strings.SplitN(k, "/", 2)[0]
			if !seen[b] {
				seen[b] = true
				fmt.Fprintf(w, "<Bucket><Name>%s</Name></Bucket>", b)
			}
		}
		io.WriteString(w, `</Buckets></ListAllMyBucketsResult>`)
		return
	}

	parts := strings.SplitN(path, "/", 2)
	bucket := parts[0]
	key := ""
	if len(parts) == 2 {
		key = parts[1]
	}

	// DeleteObjects
	if key == "" && r.Method == http.MethodPost && q.Has("delete") {
		body, _ := io.ReadAll(r.Body)
		want := base64.StdEncoding.EncodeToString(md5SumBytes(body))
		if r.Header.Get("Content-MD5") != want {
			w.WriteHeader(400)
			io.WriteString(w, "<Error><Code>InvalidDigest</Code></Error>")
			return
		}
		var del struct {
			Objects []struct {
				Key string `xml:"Key"`
			} `xml:"Object"`
		}
		_ = xml.Unmarshal(body, &del)
		f.deleteSizes = append(f.deleteSizes, len(del.Objects))
		io.WriteString(w, `<DeleteResult>`)
		for _, o := range del.Objects {
			if o.Key == f.deleteFail {
				fmt.Fprintf(w, `<Error><Key>%s</Key><Code>AccessDenied</Code><Message>Access Denied</Message></Error>`, o.Key)
				continue
			}
			delete(f.objects, f.key(bucket, o.Key))
		}
		io.WriteString(w, `</DeleteResult>`)
		return
	}

	// ListObjectsV2
	if key == "" && r.Method == http.MethodGet && q.Get("list-type") == "2" {
		prefix := q.Get("prefix")
		delimiter := q.Get("delimiter")
		token := q.Get("continuation-token")
		type item struct {
			key  string
			size int64
		}
		var contents []item
		folders := map[string]bool{}
		for k, v := range f.objects {
			if !strings.HasPrefix(k, bucket+"/") {
				continue
			}
			objKey := strings.TrimPrefix(k, bucket+"/")
			if !strings.HasPrefix(objKey, prefix) {
				continue
			}
			rest := strings.TrimPrefix(objKey, prefix)
			if delimiter != "" {
				if i := strings.Index(rest, delimiter); i >= 0 {
					folders[prefix+rest[:i+len(delimiter)]] = true
					continue
				}
			}
			contents = append(contents, item{objKey, int64(len(v))})
		}
		sort.Slice(contents, func(i, j int) bool { return contents[i].key < contents[j].key })
		start := 0
		if token != "" {
			fmt.Sscanf(token, "%d", &start)
		}
		limit := f.maxKeys
		if limit <= 0 {
			limit = len(contents) + len(folders)
		}
		fmt.Fprint(w, `<ListBucketResult>`)
		n := 0
		if delimiter != "" {
			var names []string
			for name := range folders {
				names = append(names, name)
			}
			sort.Strings(names)
			for i := start; i < len(names) && n < limit; i++ {
				fmt.Fprintf(w, `<CommonPrefixes><Prefix>%s</Prefix></CommonPrefixes>`, names[i])
				n++
			}
			if start+n < len(names) {
				fmt.Fprintf(w, `<IsTruncated>true</IsTruncated><NextContinuationToken>%d</NextContinuationToken>`, start+n)
			} else {
				fmt.Fprint(w, `<IsTruncated>false</IsTruncated>`)
			}
		} else {
			for i := start; i < len(contents) && n < limit; i++ {
				fmt.Fprintf(w, `<Contents><Key>%s</Key><Size>%d</Size></Contents>`, contents[i].key, contents[i].size)
				n++
			}
			if start+n < len(contents) && f.noToken {
				fmt.Fprint(w, `<IsTruncated>true</IsTruncated>`)
			} else if start+n < len(contents) {
				fmt.Fprintf(w, `<IsTruncated>true</IsTruncated><NextContinuationToken>%d</NextContinuationToken>`, start+n)
			} else {
				fmt.Fprint(w, `<IsTruncated>false</IsTruncated>`)
			}
		}
		fmt.Fprint(w, `</ListBucketResult>`)
		return
	}

	// HeadBucket: a bucket exists once created or holding objects.
	if key == "" && r.Method == http.MethodHead {
		exists := f.created[bucket]
		for k := range f.objects {
			exists = exists || strings.HasPrefix(k, bucket+"/")
		}
		if !exists {
			w.WriteHeader(404)
		}
		return
	}

	// Create bucket
	if key == "" && r.Method == http.MethodPut {
		if f.created == nil {
			f.created = map[string]bool{}
		}
		f.created[bucket] = true
		w.WriteHeader(200)
		return
	}

	// Multipart initiate
	if r.Method == http.MethodPost && q.Has("uploads") {
		f.uploadIDs++
		id := fmt.Sprintf("up-%d", f.uploadIDs)
		f.uploads[id] = map[int][]byte{}
		fmt.Fprintf(w, `<InitiateMultipartUploadResult><UploadId>%s</UploadId></InitiateMultipartUploadResult>`, id)
		return
	}

	// Complete / abort multipart
	if q.Get("uploadId") != "" && key != "" {
		id := q.Get("uploadId")
		if r.Method == http.MethodDelete {
			delete(f.uploads, id)
			w.WriteHeader(204)
			return
		}
		if r.Method == http.MethodPost {
			if f.completeErr {
				io.WriteString(w, `<Error><Code>InternalError</Code><Message>We encountered an internal error.</Message></Error>`)
				return
			}
			var req struct {
				Parts []struct {
					PartNumber int
					ETag       string
				} `xml:"Part"`
			}
			_ = xml.Unmarshal(reqBody, &req)
			for _, p := range req.Parts {
				if want := fmt.Sprintf(`"%x"`, md5.Sum(f.uploads[id][p.PartNumber])); p.ETag != want {
					w.WriteHeader(400)
					io.WriteString(w, "<Error><Code>InvalidPart</Code></Error>")
					return
				}
			}
			parts := f.uploads[id]
			var buf bytes.Buffer
			for i := 1; i <= len(parts); i++ {
				buf.Write(parts[i])
			}
			f.objects[f.key(bucket, key)] = buf.Bytes()
			delete(f.uploads, id)
			io.WriteString(w, `<CompleteMultipartUploadResult></CompleteMultipartUploadResult>`)
			return
		}
		if r.Method == http.MethodPut {
			partNum := 0
			fmt.Sscanf(q.Get("partNumber"), "%d", &partNum)
			if f.failPart != 0 && partNum == f.failPart {
				w.WriteHeader(500)
				io.WriteString(w, "<Error><Code>InternalError</Code></Error>")
				return
			}
			b, _ := io.ReadAll(r.Body)
			if r.Header.Get("Content-MD5") == base64.StdEncoding.EncodeToString(md5SumBytes(b)) {
				f.partMD5s++
			}
			if f.uploads[id] == nil {
				f.uploads[id] = map[int][]byte{}
			}
			f.uploads[id][partNum] = b
			w.Header().Set("ETag", fmt.Sprintf(`"%x"`, md5.Sum(b)))
			w.WriteHeader(200)
			return
		}
	}

	switch r.Method {
	case http.MethodPut:
		b, _ := io.ReadAll(r.Body)
		f.objects[f.key(bucket, key)] = b
		w.WriteHeader(200)
	case http.MethodGet:
		b, ok := f.objects[f.key(bucket, key)]
		if !ok {
			w.WriteHeader(404)
			io.WriteString(w, "<Error><Code>NoSuchKey</Code></Error>")
			return
		}
		w.Write(b)
	case http.MethodDelete:
		delete(f.objects, f.key(bucket, key))
		w.WriteHeader(204)
	default:
		w.WriteHeader(405)
	}
}

func md5SumBytes(b []byte) []byte {
	sum := md5.Sum(b)
	return sum[:]
}

func testClient(t *testing.T, f http.Handler) (*S3Client, *httptest.Server) {
	t.Helper()
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	c := NewS3Client(S3Target{Endpoint: srv.URL, Bucket: "bk", Prefix: "p", AccessKey: "AK", SecretKey: "SK"})
	return c, srv
}

func TestPutGetDeleteAndListPagination(t *testing.T) {
	f := newRichFakeS3()
	c, _ := testClient(t, f)
	ctx := context.Background()

	if err := c.PutObject(ctx, "bk", "p/a.txt", strings.NewReader("hello"), 5); err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	if err := c.GetObject(ctx, "bk", "p/a.txt", &buf); err != nil || buf.String() != "hello" {
		t.Fatal(buf.String(), err)
	}
	// Seed enough objects to force pagination (maxKeys=2).
	for i := 0; i < 5; i++ {
		key := fmt.Sprintf("p/obj-%d", i)
		if err := c.PutObject(ctx, "bk", key, strings.NewReader("x"), 1); err != nil {
			t.Fatal(err)
		}
	}
	objs, err := c.ListObjects(ctx, "bk", "p/")
	if err != nil || len(objs) < 5 {
		t.Fatalf("list got %d: %v %v", len(objs), objs, err)
	}
	if err := c.DeleteObject(ctx, "bk", "p/a.txt"); err != nil {
		t.Fatal(err)
	}
	if err := c.GetObject(ctx, "bk", "p/a.txt", io.Discard); err == nil {
		t.Fatal("expected missing object error")
	}
}

func TestMultipartUploadAndAbortOnError(t *testing.T) {
	oldThresh, oldPart := multipartThreshold, multipartPartSize
	multipartThreshold, multipartPartSize = 100, 40
	t.Cleanup(func() { multipartThreshold, multipartPartSize = oldThresh, oldPart })

	f := newRichFakeS3()
	ctx := context.Background()
	c, _ := testClient(t, f)

	payload := bytes.Repeat([]byte("abcdefghij"), 20) // 200 bytes > threshold, multiple parts
	if err := c.PutObject(ctx, "bk", "big.bin", bytes.NewReader(payload), int64(len(payload))); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	got := f.objects["bk/big.bin"]
	f.mu.Unlock()
	if !bytes.Equal(got, payload) {
		t.Fatalf("got %d bytes want %d", len(got), len(payload))
	}

	f.failPart = 1
	err := c.PutObject(ctx, "bk", "fail.bin", bytes.NewReader(payload), int64(len(payload)))
	if err == nil {
		t.Fatal("expected multipart part failure")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.objects["bk/fail.bin"]; ok {
		t.Fatal("failed upload should not complete")
	}
	if len(f.uploads) != 0 {
		t.Fatalf("upload should be aborted, still have %v", f.uploads)
	}
}

func TestDeletePrefixBatch(t *testing.T) {
	f := newRichFakeS3()
	c, _ := testClient(t, f)
	ctx := context.Background()
	for i := 0; i < 3; i++ {
		key := fmt.Sprintf("p/id/%d.txt", i)
		if err := c.PutObject(ctx, "bk", key, strings.NewReader("z"), 1); err != nil {
			t.Fatal(err)
		}
	}
	if err := c.DeletePrefix(ctx, "bk", "p/id/"); err != nil {
		t.Fatal(err)
	}
	objs, err := c.ListObjects(ctx, "bk", "p/id/")
	if err != nil || len(objs) != 0 {
		t.Fatal(objs, err)
	}
}

func TestStoreRemoteRoundTrip(t *testing.T) {
	f := newRichFakeS3()
	c, srv := testClient(t, f)
	_ = c
	tg := S3Target{Endpoint: srv.URL, Bucket: "bk", Prefix: "p", AccessKey: "AK", SecretKey: "SK"}.Normalize()
	UseExternalTarget(tg)
	t.Cleanup(func() { externalS3 = nil })

	dir := t.TempDir()
	src := filepath.Join(dir, "config.tar.age")
	if err := os.WriteFile(src, []byte("encrypted-bytes"), 0600); err != nil {
		t.Fatal(err)
	}
	s := Store{Target: Target{Remote: true, Path: MCAlias + "/bk/p/archives"}}
	if err := s.Put("20260101T000000Z", "config.tar.age", src); err != nil {
		t.Fatal(err)
	}
	manifest := filepath.Join(dir, "backup.json")
	if err := os.WriteFile(manifest, []byte(`{"version":1,"id":"20260101T000000Z","createdAt":"2026-01-01T00:00:00Z","platformVersion":"test","artifacts":[{"component":"config","file":"config.tar.age","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","bytes":1}]}`), 0600); err != nil {
		t.Fatal(err)
	}
	// Fix checksum to match file.
	sum, n, err := Checksum(src)
	if err != nil {
		t.Fatal(err)
	}
	mbody := fmt.Sprintf(`{"version":1,"id":"20260101T000000Z","createdAt":"2026-01-01T00:00:00Z","platformVersion":"test","artifacts":[{"component":"config","file":"config.tar.age","sha256":"%s","bytes":%d}]}`, sum, n)
	if err := os.WriteFile(manifest, []byte(mbody), 0600); err != nil {
		t.Fatal(err)
	}
	if err := s.Put("20260101T000000Z", "backup.json", manifest); err != nil {
		t.Fatal(err)
	}
	items, incomplete, err := s.ListWithIncomplete()
	if err != nil || len(incomplete) != 0 || len(items) != 1 || items[0].ID != "20260101T000000Z" {
		t.Fatalf("list: items=%v incomplete=%v err=%v", items, incomplete, err)
	}
	dst := filepath.Join(dir, "out.tar.age")
	if err := s.Get("20260101T000000Z", "config.tar.age", dst); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(dst)
	if string(got) != "encrypted-bytes" {
		t.Fatal(string(got))
	}
	if err := s.remove("20260101T000000Z", "config.tar.age"); err != nil {
		t.Fatal(err)
	}
}

func TestEnsureBucketAndListBuckets(t *testing.T) {
	f := newRichFakeS3()
	c, _ := testClient(t, f)
	ctx := context.Background()
	if err := c.EnsureBucket(ctx, "bk"); err != nil {
		t.Fatal(err)
	}
	if err := c.PutObject(ctx, "other", "x", strings.NewReader("1"), 1); err != nil {
		t.Fatal(err)
	}
	names, err := c.ListBuckets(ctx)
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(names, ",")
	if !strings.Contains(joined, "other") {
		t.Fatal(names)
	}
}

// The AWS SigV4 "GET Bucket (List Objects)" example: checks the canonical
// query string, not just the path.
func TestSignListObjectsAWSExample(t *testing.T) {
	req, _ := http.NewRequest(http.MethodGet, "https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J", nil)
	Sign(req, nil, "AKIAIOSFODNN7EXAMPLE", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "us-east-1", time.Date(2013, 5, 24, 0, 0, 0, 0, time.UTC))
	want := "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7"
	if got := req.Header.Get("Authorization"); got != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
}

// The query string sent must be exactly the canonical query that was signed,
// and decode back to the original values, for continuation tokens and
// prefixes with characters that need encoding.
func TestQueryEncodingRoundTrips(t *testing.T) {
	c := NewS3Client(S3Target{Endpoint: "http://10.0.0.1:9000", AccessKey: "AK", SecretKey: "SK"})
	tricky := []string{"1/abc+def==", "a b~c*d", "ü/ä?&=#%", "x-y_z.~"}
	for _, v := range tricky {
		q := url.Values{"list-type": {"2"}, "continuation-token": {v}, "prefix": {v}}
		u, err := c.objectURL("bk", "", q)
		if err != nil {
			t.Fatal(err)
		}
		if u.RawQuery != canonicalQuery(q) {
			t.Fatalf("sent %q, signed %q", u.RawQuery, canonicalQuery(q))
		}
		back, err := url.ParseQuery(u.RawQuery)
		if err != nil || back.Get("continuation-token") != v || back.Get("prefix") != v {
			t.Fatalf("%q decoded as %v (%v)", v, back, err)
		}
		if strings.ContainsAny(u.RawQuery, "+ ") || strings.Contains(u.RawQuery, "*") {
			t.Fatalf("not SigV4-encoded: %q", u.RawQuery)
		}
	}
	u, _ := c.objectURL("bk", "dir/a b+c(1).txt", nil)
	if u.EscapedPath() != "/bk/dir/a%20b%2Bc%281%29.txt" {
		t.Fatal(u.EscapedPath())
	}
}

func TestPutEmptyFileIsNotChunked(t *testing.T) {
	f := newRichFakeS3()
	c, _ := testClient(t, f)
	p := filepath.Join(t.TempDir(), "empty")
	if err := os.WriteFile(p, nil, 0600); err != nil {
		t.Fatal(err)
	}
	if err := c.PutFile(context.Background(), "bk", "empty", p); err != nil {
		t.Fatal(err)
	}
	if b, ok := f.objects["bk/empty"]; !ok || len(b) != 0 {
		t.Fatalf("empty object not stored: %v %v", b, ok)
	}
}

func TestMultipartFromFileSignsPartsAndSendsMD5(t *testing.T) {
	oldThresh, oldPart := multipartThreshold, multipartPartSize
	multipartThreshold, multipartPartSize = 100, 40
	t.Cleanup(func() { multipartThreshold, multipartPartSize = oldThresh, oldPart })
	f := newRichFakeS3()
	c, _ := testClient(t, f)
	payload := bytes.Repeat([]byte("0123456789"), 12) // 120 bytes: parts of 40
	p := filepath.Join(t.TempDir(), "big")
	if err := os.WriteFile(p, payload, 0600); err != nil {
		t.Fatal(err)
	}
	if err := c.PutFile(context.Background(), "bk", "big", p); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(f.objects["bk/big"], payload) {
		t.Fatal("multipart object differs")
	}
	if f.partMD5s != 3 {
		t.Fatalf("parts with Content-MD5 = %d, want 3", f.partMD5s)
	}
}

func TestMultipartCompleteErrorIn200IsAFailureAndAborts(t *testing.T) {
	oldThresh, oldPart := multipartThreshold, multipartPartSize
	multipartThreshold, multipartPartSize = 10, 8
	t.Cleanup(func() { multipartThreshold, multipartPartSize = oldThresh, oldPart })
	f := newRichFakeS3()
	f.completeErr = true
	c, _ := testClient(t, f)
	err := c.PutObject(context.Background(), "bk", "x", bytes.NewReader(make([]byte, 20)), 20)
	if err == nil || !strings.Contains(err.Error(), "InternalError") {
		t.Fatalf("expected InternalError, got %v", err)
	}
	if len(f.uploads) != 0 {
		t.Fatalf("upload not aborted: %v", f.uploads)
	}
}

func TestMultipartSizeMismatchAborts(t *testing.T) {
	oldThresh, oldPart := multipartThreshold, multipartPartSize
	multipartThreshold, multipartPartSize = 10, 8
	t.Cleanup(func() { multipartThreshold, multipartPartSize = oldThresh, oldPart })
	f := newRichFakeS3()
	c, _ := testClient(t, f)
	if err := c.PutObject(context.Background(), "bk", "x", bytes.NewReader(make([]byte, 15)), 20); err == nil {
		t.Fatal("short body accepted")
	}
	if len(f.uploads) != 0 || f.objects["bk/x"] != nil {
		t.Fatal("short upload left behind")
	}
}

func TestPartSizeStaysWithinPartLimit(t *testing.T) {
	if got := partSizeFor(100 << 20); got != multipartPartSize {
		t.Fatal(got)
	}
	huge := int64(500) << 30 // 500 GiB
	ps := partSizeFor(huge)
	if (huge+ps-1)/ps > maxMultipartParts || ps%(1<<20) != 0 {
		t.Fatalf("part size %d gives too many parts", ps)
	}
}

func TestDeleteObjectsBatchesAndReportsFailures(t *testing.T) {
	f := newRichFakeS3()
	c, _ := testClient(t, f)
	keys := make([]string, 2500)
	for i := range keys {
		keys[i] = fmt.Sprintf("p/%04d", i)
	}
	if err := c.DeleteObjects(context.Background(), "bk", keys); err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(f.deleteSizes) != "[1000 1000 500]" {
		t.Fatal(f.deleteSizes)
	}
	f.deleteFail = "p/0007"
	err := c.DeleteObjects(context.Background(), "bk", keys[:10])
	if err == nil || !strings.Contains(err.Error(), "p/0007") || !strings.Contains(err.Error(), "1 of 10") {
		t.Fatalf("partial delete failure not reported: %v", err)
	}
}

func TestListObjectsRejectsTruncationWithoutToken(t *testing.T) {
	f := newRichFakeS3()
	c, _ := testClient(t, f)
	for i := 0; i < 3; i++ {
		f.objects[fmt.Sprintf("bk/k%d", i)] = []byte("x")
	}
	f.noToken = true
	if _, err := c.ListObjects(context.Background(), "bk", ""); err == nil {
		t.Fatal("silently truncated listing")
	}
}

func TestGetMissingObjectSaysObjectNotBucket(t *testing.T) {
	f := newRichFakeS3()
	c, _ := testClient(t, f)
	dst := filepath.Join(t.TempDir(), "out")
	err := c.GetFile(context.Background(), "bk", "nope", dst)
	if err == nil || !strings.Contains(err.Error(), "object does not exist") {
		t.Fatal(err)
	}
	if _, statErr := os.Stat(dst); !os.IsNotExist(statErr) {
		t.Fatal("partial file left behind")
	}
}

func TestValidObjectPath(t *testing.T) {
	for _, k := range []string{"a", "a/b.txt", "a b/c+d", `back\slash`} {
		if !validObjectPath(k) {
			t.Errorf("%q rejected", k)
		}
	}
	for _, k := range []string{"", "/abs", "../x", "a/../../x", "a//b", "./a", "a/.", "dir/"} {
		if validObjectPath(k) {
			t.Errorf("%q accepted", k)
		}
	}
}
