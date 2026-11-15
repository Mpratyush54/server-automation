package backup

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// AWS documentation example "GET Object" (Signature Version 4, header auth).
func TestSignMatchesAWSExample(t *testing.T) {
	req, _ := http.NewRequest(http.MethodGet, "https://examplebucket.s3.amazonaws.com/test.txt", nil)
	req.Header.Set("Range", "bytes=0-9")
	Sign(req, nil, "AKIAIOSFODNN7EXAMPLE", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "us-east-1", time.Date(2013, 5, 24, 0, 0, 0, 0, time.UTC))
	want := "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
	if got := req.Header.Get("Authorization"); got != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
}

func TestTargetValidationAndDerivedSettings(t *testing.T) {
	ok := S3Target{Endpoint: "https://acct.r2.cloudflarestorage.com/", Bucket: "cairn-backups", Region: "auto", Prefix: "/server-a/", AccessKey: "AK", SecretKey: "SK"}.Normalize()
	if err := ok.Validate(); err != nil {
		t.Fatal(err)
	}
	if ok.Prefix != "server-a" || ok.Endpoint != "https://acct.r2.cloudflarestorage.com" {
		t.Fatal(ok)
	}
	if ok.PostgresDestination() != "s3://cairn-backups/server-a/postgres/" || ok.ArchiveTarget() != "s3://platformtarget/cairn-backups/server-a/archives" || ok.LonghornBackupTarget() != "s3://cairn-backups@auto/server-a/longhorn" {
		t.Fatal(ok.PostgresDestination(), ok.ArchiveTarget(), ok.LonghornBackupTarget())
	}
	if _, err := ParseTarget(ok.ArchiveTarget()); err != nil {
		t.Fatal(err)
	}
	if ok.Describe() != "acct.r2.cloudflarestorage.com/cairn-backups/server-a" {
		t.Fatal(ok.Describe())
	}
	etcd := ok.EtcdSecretData()
	if etcd["etcd-s3-endpoint"] != "acct.r2.cloudflarestorage.com" || etcd["etcd-s3-folder"] != "server-a/etcd" || etcd["etcd-s3-insecure"] != "false" {
		t.Fatal(etcd)
	}
	aws := S3Target{Bucket: "my-bucket", Region: "eu-west-1"}
	if aws.EndpointURL() != "https://s3.eu-west-1.amazonaws.com" || aws.PostgresDestination() != "s3://my-bucket/postgres/" {
		t.Fatal(aws.EndpointURL())
	}
	if _, has := aws.LonghornSecretData()["AWS_ENDPOINTS"]; has {
		t.Fatal("AWS needs no endpoint override")
	}
	if !(S3Target{Endpoint: "http://10.0.0.5:9000", Bucket: "bk1"}).Insecure() {
		t.Fatal("http endpoint")
	}
	for _, bad := range []S3Target{
		{Bucket: "x"}, {Bucket: "UPPER"}, {Bucket: "ok-bucket", Endpoint: "ftp://h"}, {Bucket: "ok-bucket", Endpoint: "https://u:p@h"},
		{Bucket: "ok-bucket", Endpoint: "https://h/path"}, {Bucket: "ok-bucket", Prefix: "a/../b"}, {Bucket: "ok-bucket", Prefix: "has space"},
		{Bucket: "ok-bucket", Region: "Bad Region"},
	} {
		if bad.Normalize().ValidateSettings() == nil {
			t.Fatalf("accepted %+v", bad)
		}
	}
	if (S3Target{Bucket: "ok-bucket"}).Validate() == nil {
		t.Fatal("credentials are required")
	}
	// The summary for the API never carries credentials.
	sum := SummaryData(ModeExternal, &ok, time.Unix(0, 0))
	for _, v := range sum {
		if strings.Contains(v, "SK") || strings.Contains(v, "AK") {
			t.Fatal(sum)
		}
	}
	if SummaryData(ModeLocal, nil, time.Unix(0, 0))["mode"] != ModeLocal {
		t.Fatal("local mode")
	}
	if TargetFromSecretData(ok.SecretData()) != ok {
		t.Fatal("secret round trip")
	}
}

// fakeS3 is a tiny path-style object store that requires signed requests.
type fakeS3 struct {
	mu      sync.Mutex
	objects map[string][]byte
	calls   []string
	deny    string // method to answer 403
	bucket  string
}

func (f *fakeS3) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, r.Method+" "+r.URL.Path)
	if !strings.HasPrefix(r.Header.Get("Authorization"), "AWS4-HMAC-SHA256 Credential=AK/") || r.Header.Get("x-amz-content-sha256") == "" {
		w.WriteHeader(403)
		io.WriteString(w, "<Error><Code>SignatureDoesNotMatch</Code></Error>")
		return
	}
	if r.Method == f.deny {
		w.WriteHeader(403)
		io.WriteString(w, "<Error><Code>AccessDenied</Code></Error>")
		return
	}
	parts := strings.SplitN(strings.TrimPrefix(r.URL.Path, "/"), "/", 2)
	if parts[0] != f.bucket {
		w.WriteHeader(404)
		io.WriteString(w, "<Error><Code>NoSuchBucket</Code></Error>")
		return
	}
	if len(parts) == 1 {
		io.WriteString(w, `<ListBucketResult><CommonPrefixes><Prefix>p/postgres/postgresql/</Prefix></CommonPrefixes><CommonPrefixes><Prefix>p/postgres/postgresql-17000/</Prefix></CommonPrefixes></ListBucketResult>`)
		return
	}
	switch r.Method {
	case http.MethodPut:
		b, _ := io.ReadAll(r.Body)
		f.objects[parts[1]] = b
	case http.MethodGet:
		b, ok := f.objects[parts[1]]
		if !ok {
			w.WriteHeader(404)
			return
		}
		w.Write(b)
	case http.MethodDelete:
		delete(f.objects, parts[1])
		w.WriteHeader(204)
	}
}

func TestProbeWritesReadsAndDeletes(t *testing.T) {
	f := &fakeS3{objects: map[string][]byte{}, bucket: "bk-1"}
	srv := httptest.NewServer(f)
	defer srv.Close()
	c := NewS3Client(S3Target{Endpoint: srv.URL, Bucket: "bk-1", Prefix: "p", AccessKey: "AK", SecretKey: "SK"})
	if err := c.Probe(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(f.objects) != 0 || len(f.calls) != 3 || !strings.HasPrefix(f.calls[0], "PUT /bk-1/p/.platform-probe-") || !strings.HasPrefix(f.calls[2], "DELETE ") {
		t.Fatal(f.calls, f.objects)
	}
	names, err := c.ListFolders(context.Background(), "p/postgres")
	if err != nil || strings.Join(names, ",") != "postgresql,postgresql-17000" {
		t.Fatal(names, err)
	}

	f.deny = http.MethodDelete
	err = c.Probe(context.Background())
	if err == nil || !strings.Contains(err.Error(), "cannot delete from the backup target") || !strings.Contains(err.Error(), "access denied") {
		t.Fatal(err)
	}
	f.deny = ""

	wrong := NewS3Client(S3Target{Endpoint: srv.URL, Bucket: "missing", AccessKey: "AK", SecretKey: "SK"})
	if err := wrong.Probe(context.Background()); err == nil || !strings.Contains(err.Error(), `bucket "missing" does not exist`) {
		t.Fatal(err)
	}
	badKey := NewS3Client(S3Target{Endpoint: srv.URL, Bucket: "bk-1", AccessKey: "other", SecretKey: "SK"})
	err = badKey.Probe(context.Background())
	if err == nil || !strings.Contains(err.Error(), "access key or secret key is wrong") || strings.Contains(err.Error(), "SK") {
		t.Fatal(err)
	}
	unreachable := NewS3Client(S3Target{Endpoint: "http://127.0.0.1:1", Bucket: "bk-1", AccessKey: "AK", SecretKey: "SK"})
	unreachable.HTTP.Timeout = 2 * time.Second
	if err := unreachable.Probe(context.Background()); err == nil || !strings.Contains(err.Error(), "did not answer") {
		t.Fatal(err)
	}
}

func TestSummaryDataKeepsEndpointScheme(t *testing.T) {
	tg := S3Target{Endpoint: "http://10.0.0.5:9000/", Bucket: "offsite"}.Normalize()
	sum := SummaryData(ModeExternal, &tg, time.Unix(0, 0))
	if sum["endpoint"] != "http://10.0.0.5:9000" || sum["endpointHost"] != "10.0.0.5:9000" {
		t.Fatal(sum)
	}
}
