package backup

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

type bucketTransport func(*http.Request) (*http.Response, error)

func (f bucketTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestEnsureBucket(t *testing.T) {
	for _, status := range []int{200, 404, 403, 301} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			calls := 0
			c := NewS3Client(S3Target{Endpoint: "https://s3.example.com", Bucket: "cairn-uploads", Region: "eu-west-1", AccessKey: "test", SecretKey: "test"})
			c.HTTP = &http.Client{Transport: bucketTransport(func(r *http.Request) (*http.Response, error) {
				calls++
				if r.Header.Get("Authorization") == "" {
					t.Error("unsigned request")
				}
				st := status
				if calls == 2 {
					body, _ := io.ReadAll(r.Body)
					if r.Method != "PUT" || !strings.Contains(string(body), "<LocationConstraint>eu-west-1</LocationConstraint>") {
						t.Error("bad create request")
					}
					st = 200
				}
				return &http.Response{StatusCode: st, Body: io.NopCloser(strings.NewReader("")), Header: http.Header{}}, nil
			})}
			err := c.EnsureBucket(context.Background())
			if (err != nil) != (status == 403 || status == 301) {
				t.Fatal(err)
			}
			want := 1
			if status == 404 {
				want = 2
			}
			if calls != want {
				t.Fatal(calls)
			}
		})
	}
}

func TestBucketVirtualHostedStyle(t *testing.T) {
	c := NewS3Client(S3Target{Endpoint: "https://s3.example.com", Bucket: "cairn-uploads"})
	c.VirtualHostedStyle = true
	c.HTTP = &http.Client{Transport: bucketTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "cairn-uploads.s3.example.com" || r.URL.Path != "/" {
			t.Fatal(r.URL)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(""))}, nil
	})}
	if err := c.EnsureBucket(context.Background()); err != nil {
		t.Fatal(err)
	}
}
