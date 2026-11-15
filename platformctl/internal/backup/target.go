package backup

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"
)

// The external backup target (#186): one S3-compatible bucket (AWS S3,
// Cloudflare R2, Backblaze B2, a remote MinIO) that receives the PostgreSQL
// WAL archive and base backups, the encrypted `platformctl backup` archives,
// etcd snapshots and Longhorn volume backups. Only the non-secret settings are
// saved on the host (/etc/platform/.env); the access key and secret live in
// Kubernetes Secrets.

// Backup storage modes, saved as BACKUP_MODE.
const (
	ModeExternal = "external"
	ModeLocal    = "local"
)

// Kubernetes objects that carry the target. The master Secret is in the
// platform namespace (and so inside the encrypted config archive); the others
// are copies in the formats each consumer expects.
const (
	TargetSecret          = "platform-backup-target" // namespace platform: all fields
	TargetConfigMap       = "platform-backup-target" // namespace platform: non-secret summary for the API
	PostgresTargetSecret  = "platform-backup-s3"     // namespace databases: Barman Cloud ObjectStore
	EtcdTargetSecret      = "platform-etcd-s3"       // namespace kube-system: k3s etcd-s3-config-secret
	LonghornTargetSecret  = "platform-longhorn-backup"
	MCAlias               = "platformtarget" // placeholder host in s3:// URLs for the configured target
	ExternalTargetKeyword = "external"       // backup.json "target" value that resolves to the target
)

// Sub-prefixes inside the target, one per consumer.
const (
	PrefixPostgres = "postgres"
	PrefixArchives = "archives"
	PrefixEtcd     = "etcd"
	PrefixLonghorn = "longhorn"
)

// S3Target is the external target. Endpoint is empty for AWS S3.
type S3Target struct {
	Endpoint  string `json:"endpoint,omitempty"`
	Bucket    string `json:"bucket"`
	Region    string `json:"region,omitempty"`
	Prefix    string `json:"prefix,omitempty"`
	AccessKey string `json:"-"`
	SecretKey string `json:"-"`
}

var (
	bucketRE    = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$`)
	regionRE    = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,40}$`)
	prefixSegRE = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]*$`)
)

// Normalize trims whitespace and slashes.
func (t S3Target) Normalize() S3Target {
	t.Endpoint = strings.TrimRight(strings.TrimSpace(t.Endpoint), "/")
	t.Bucket = strings.TrimSpace(t.Bucket)
	t.Region = strings.TrimSpace(t.Region)
	t.Prefix = strings.Trim(strings.TrimSpace(t.Prefix), "/")
	t.AccessKey = strings.TrimSpace(t.AccessKey)
	t.SecretKey = strings.TrimSpace(t.SecretKey)
	return t
}

// ValidateSettings checks the non-secret fields.
func (t S3Target) ValidateSettings() error {
	if t.Endpoint != "" {
		u, err := url.Parse(t.Endpoint)
		if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
			return fmt.Errorf("the backup endpoint must look like https://s3.example.com (no path, no credentials)")
		}
	}
	if !bucketRE.MatchString(t.Bucket) || strings.Contains(t.Bucket, "..") {
		return fmt.Errorf("the backup bucket name %q is not a valid S3 bucket name", t.Bucket)
	}
	if t.Region != "" && !regionRE.MatchString(t.Region) {
		return fmt.Errorf("the backup region %q is not valid (for example us-east-1, auto)", t.Region)
	}
	if t.Prefix != "" {
		for _, s := range strings.Split(t.Prefix, "/") {
			if !prefixSegRE.MatchString(s) || s == "." || s == ".." {
				return fmt.Errorf("the backup prefix may only contain letters, digits, '.', '_', '-' and '/'")
			}
		}
	}
	for _, v := range []string{t.Endpoint, t.Bucket, t.Region, t.Prefix} {
		if strings.ContainsAny(v, "\r\n\"'\\ ") {
			return fmt.Errorf("backup target settings cannot contain quotes, spaces or line breaks")
		}
	}
	return nil
}

// Validate checks settings and credentials.
func (t S3Target) Validate() error {
	if err := t.ValidateSettings(); err != nil {
		return err
	}
	if t.AccessKey == "" || t.SecretKey == "" {
		return fmt.Errorf("the backup target needs an access key and a secret key")
	}
	if strings.ContainsAny(t.AccessKey+t.SecretKey, "\r\n") {
		return fmt.Errorf("backup credentials cannot contain line breaks")
	}
	return nil
}

// SigningRegion is the region used for request signing.
func (t S3Target) SigningRegion() string {
	if t.Region == "" {
		return "us-east-1"
	}
	return t.Region
}

// EndpointURL is the effective endpoint (AWS when none is set).
func (t S3Target) EndpointURL() string {
	if t.Endpoint != "" {
		return t.Endpoint
	}
	return "https://s3." + t.SigningRegion() + ".amazonaws.com"
}

// EndpointHost is the endpoint host[:port], safe to display.
func (t S3Target) EndpointHost() string {
	u, err := url.Parse(t.EndpointURL())
	if err != nil {
		return ""
	}
	return u.Host
}

// Insecure reports a plain-http endpoint (only sensible on a private network).
func (t S3Target) Insecure() bool { return strings.HasPrefix(t.EndpointURL(), "http://") }

// Key joins the target prefix with a sub-path.
func (t S3Target) Key(parts ...string) string {
	all := []string{}
	if t.Prefix != "" {
		all = append(all, t.Prefix)
	}
	for _, p := range parts {
		if p = strings.Trim(p, "/"); p != "" {
			all = append(all, p)
		}
	}
	return strings.Join(all, "/")
}

// Describe is a one-line, credential-free description.
func (t S3Target) Describe() string {
	s := t.EndpointHost() + "/" + t.Bucket
	if t.Prefix != "" {
		s += "/" + t.Prefix
	}
	return s
}

// PostgresDestination is the Barman Cloud destinationPath.
func (t S3Target) PostgresDestination() string {
	return "s3://" + t.Bucket + "/" + t.Key(PrefixPostgres) + "/"
}

// ArchiveTarget is the backup.Store URL for encrypted archives. The host
// "platformtarget" is a stable placeholder; credentials come from
// UseExternalTarget, not from an mc alias.
func (t S3Target) ArchiveTarget() string {
	return "s3://" + MCAlias + "/" + t.Bucket + "/" + t.Key(PrefixArchives)
}

// LonghornBackupTarget is the Longhorn backup target URL.
func (t S3Target) LonghornBackupTarget() string {
	return "s3://" + t.Bucket + "@" + t.SigningRegion() + "/" + t.Key(PrefixLonghorn)
}

// SecretData returns the master Secret's data.
func (t S3Target) SecretData() map[string]string {
	return map[string]string{"endpoint": t.Endpoint, "bucket": t.Bucket, "region": t.Region, "prefix": t.Prefix, "access-key": t.AccessKey, "secret-key": t.SecretKey}
}

// TargetFromSecretData reverses SecretData.
func TargetFromSecretData(d map[string]string) S3Target {
	return S3Target{Endpoint: d["endpoint"], Bucket: d["bucket"], Region: d["region"], Prefix: d["prefix"], AccessKey: d["access-key"], SecretKey: d["secret-key"]}.Normalize()
}

// PostgresSecretData is the ObjectStore credential Secret.
func (t S3Target) PostgresSecretData() map[string]string {
	return map[string]string{"ACCESS_KEY_ID": t.AccessKey, "ACCESS_SECRET_KEY": t.SecretKey, "REGION": t.SigningRegion()}
}

// EtcdSecretData is the k3s etcd-s3-config-secret.
func (t S3Target) EtcdSecretData() map[string]string {
	insecure := "false"
	if t.Insecure() {
		insecure = "true"
	}
	return map[string]string{
		"etcd-s3-endpoint": t.EndpointHost(), "etcd-s3-bucket": t.Bucket, "etcd-s3-region": t.SigningRegion(),
		"etcd-s3-folder": t.Key(PrefixEtcd), "etcd-s3-access-key": t.AccessKey, "etcd-s3-secret-key": t.SecretKey,
		"etcd-s3-insecure": insecure,
	}
}

// LonghornSecretData is the Longhorn backup target credential Secret.
func (t S3Target) LonghornSecretData() map[string]string {
	m := map[string]string{"AWS_ACCESS_KEY_ID": t.AccessKey, "AWS_SECRET_ACCESS_KEY": t.SecretKey}
	if t.Endpoint != "" {
		m["AWS_ENDPOINTS"] = t.Endpoint
	}
	return m
}

// SummaryData is the non-secret ConfigMap the API reads.
func SummaryData(mode string, t *S3Target, now time.Time) map[string]string {
	d := map[string]string{"mode": mode, "updatedAt": now.UTC().Format(time.RFC3339)}
	if mode == ModeExternal && t != nil {
		d["endpointHost"], d["bucket"], d["region"], d["prefix"] = t.EndpointHost(), t.Bucket, t.SigningRegion(), t.Prefix
		// The endpoint as configured, scheme included (http:// stays visible).
		d["endpoint"] = t.EndpointURL()
	}
	return d
}

// SecretManifest renders a Secret as JSON for `kubectl apply -f -` (stdin).
func SecretManifest(namespace, name string, data map[string]string) map[string]any {
	return map[string]any{"apiVersion": "v1", "kind": "Secret", "type": "Opaque",
		"metadata":   map[string]any{"name": name, "namespace": namespace, "labels": map[string]string{"app.kubernetes.io/part-of": "platform", "platform.io/backup-target": "true"}},
		"stringData": data}
}

// ---------------------------------------------------------------------------
// S3 client (AWS Signature Version 4, path-style requests unless
// VirtualHostedStyle is set). Used for backup
// target probe/list and for archive put/get/delete (including multipart).

const unsignedPayload = "UNSIGNED-PAYLOAD"

// S3Client talks to the target. HTTP and Now are replaceable in tests.
// Small requests (probe, list, delete) use HTTP's overall Timeout; object
// transfers use the same Transport without one (see transferHTTP).
type S3Client struct {
	Target             S3Target
	VirtualHostedStyle bool
	HTTP               *http.Client
	Now                func() time.Time
}

func NewS3Client(t S3Target) *S3Client {
	return &S3Client{Target: t, HTTP: &http.Client{Timeout: 30 * time.Second, Transport: s3Transport}, Now: time.Now}
}

// Transfer timeouts: connecting, the TLS handshake and waiting for response
// headers are bounded, and a connection that moves no bytes for s3IdleTimeout
// is closed. There is deliberately no limit on the total transfer time.
const (
	s3DialTimeout   = 30 * time.Second
	s3IdleTimeout   = 2 * time.Minute
	s3HeaderTimeout = 5 * time.Minute // CompleteMultipartUpload can take a while
)

var s3Transport = &http.Transport{
	Proxy: http.ProxyFromEnvironment,
	DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
		conn, err := (&net.Dialer{Timeout: s3DialTimeout, KeepAlive: 30 * time.Second}).DialContext(ctx, network, addr)
		if err != nil {
			return nil, err
		}
		return &idleConn{Conn: conn}, nil
	},
	ForceAttemptHTTP2:     true,
	MaxIdleConns:          10,
	IdleConnTimeout:       90 * time.Second,
	TLSHandshakeTimeout:   15 * time.Second,
	ResponseHeaderTimeout: s3HeaderTimeout,
	ExpectContinueTimeout: time.Second,
}

// idleConn pushes the read/write deadline forward on every successful I/O, so
// only a stalled connection times out, never a long but progressing transfer.
type idleConn struct{ net.Conn }

func (c *idleConn) Read(b []byte) (int, error) {
	_ = c.Conn.SetReadDeadline(time.Now().Add(s3IdleTimeout))
	return c.Conn.Read(b)
}

func (c *idleConn) Write(b []byte) (int, error) {
	_ = c.Conn.SetWriteDeadline(time.Now().Add(s3IdleTimeout))
	return c.Conn.Write(b)
}

func (c *S3Client) httpClient() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return &http.Client{Timeout: 30 * time.Second, Transport: s3Transport}
}

// transferHTTP is used for object put/get: no overall timeout so large
// objects can stream; dial, TLS, header and idle timeouts come from the
// Transport.
func (c *S3Client) transferHTTP() *http.Client {
	base := c.httpClient()
	return &http.Client{Transport: base.Transport, CheckRedirect: base.CheckRedirect, Jar: base.Jar}
}

func sha256Hex(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }
func hmacSHA256(key []byte, s string) []byte {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(s))
	return m.Sum(nil)
}

// s3Escape encodes a path per SigV4 (RFC 3986 unreserved characters kept, '/' kept).
func s3Escape(p string) string {
	var b strings.Builder
	for _, c := range []byte(p) {
		if (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~' || c == '/' {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

func canonicalQuery(q url.Values) string {
	keys := make([]string, 0, len(q))
	for k := range q {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var parts []string
	for _, k := range keys {
		vals := append([]string(nil), q[k]...)
		sort.Strings(vals)
		for _, v := range vals {
			parts = append(parts, strings.ReplaceAll(url.QueryEscape(k), "+", "%20")+"="+strings.ReplaceAll(url.QueryEscape(v), "+", "%20"))
		}
	}
	return strings.Join(parts, "&")
}

// Sign adds SigV4 headers for a known body (hashed). Every header already on
// the request is signed.
func Sign(req *http.Request, body []byte, accessKey, secretKey, region string, now time.Time) {
	SignWithHash(req, sha256Hex(body), accessKey, secretKey, region, now)
}

// SignWithHash adds SigV4 headers using an explicit payload hash, for example
// UNSIGNED-PAYLOAD when streaming a body that is not buffered.
func SignWithHash(req *http.Request, payloadHash, accessKey, secretKey, region string, now time.Time) {
	amzDate := now.UTC().Format("20060102T150405Z")
	day := amzDate[:8]
	req.Header.Set("x-amz-date", amzDate)
	req.Header.Set("x-amz-content-sha256", payloadHash)
	headers := map[string]string{"host": req.URL.Host}
	for k, v := range req.Header {
		lk := strings.ToLower(k)
		if lk == "authorization" || lk == "user-agent" {
			continue
		}
		headers[lk] = strings.TrimSpace(strings.Join(v, ","))
	}
	names := make([]string, 0, len(headers))
	for k := range headers {
		names = append(names, k)
	}
	sort.Strings(names)
	var canonHeaders strings.Builder
	for _, k := range names {
		canonHeaders.WriteString(k + ":" + headers[k] + "\n")
	}
	signed := strings.Join(names, ";")
	path := req.URL.EscapedPath()
	if req.URL.RawPath == "" {
		path = s3Escape(req.URL.Path)
	}
	if path == "" {
		path = "/"
	}
	canonical := strings.Join([]string{req.Method, path, canonicalQuery(req.URL.Query()), canonHeaders.String(), signed, payloadHash}, "\n")
	scope := day + "/" + region + "/s3/aws4_request"
	toSign := "AWS4-HMAC-SHA256\n" + amzDate + "\n" + scope + "\n" + sha256Hex([]byte(canonical))
	k := hmacSHA256([]byte("AWS4"+secretKey), day)
	k = hmacSHA256(k, region)
	k = hmacSHA256(k, "s3")
	k = hmacSHA256(k, "aws4_request")
	sig := hex.EncodeToString(hmacSHA256(k, toSign))
	req.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential="+accessKey+"/"+scope+", SignedHeaders="+signed+", Signature="+sig)
}

// objectURL builds the URL for bucket[/key]: path-style by default,
// <bucket>.<host>/<key> when VirtualHostedStyle is set (external object
// storage, #176). Requests without a bucket (ListBuckets) use the bare host.
func (c *S3Client) objectURL(bucket, key string, query url.Values) (*url.URL, error) {
	u, err := url.Parse(c.Target.EndpointURL())
	if err != nil {
		return nil, err
	}
	u.Path = "/"
	switch {
	case bucket != "" && c.VirtualHostedStyle:
		u.Host = bucket + "." + u.Host
		u.Path += key
	case bucket != "":
		u.Path += bucket
		if key != "" {
			u.Path += "/" + key
		}
	}
	u.RawPath = s3Escape(u.Path)
	if query != nil {
		u.RawQuery = canonicalQuery(query)
	}
	return u, nil
}

func (c *S3Client) do(ctx context.Context, method, key string, query url.Values, body []byte) (int, []byte, error) {
	return c.doBucket(ctx, method, c.Target.Bucket, key, query, body)
}

func (c *S3Client) doBucket(ctx context.Context, method, bucket, key string, query url.Values, body []byte) (int, []byte, error) {
	resp, err := c.doRequest(ctx, c.httpClient(), method, bucket, key, query, bytes.NewReader(body), int64(len(body)), sha256Hex(body))
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	return resp.StatusCode, b, nil
}

func (c *S3Client) doRequest(ctx context.Context, client *http.Client, method, bucket, key string, query url.Values, body io.Reader, contentLength int64, payloadHash string) (*http.Response, error) {
	u, err := c.objectURL(bucket, key, query)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), body)
	if err != nil {
		return nil, err
	}
	if contentLength == 0 {
		// A non-nil body with ContentLength 0 would be sent chunked, which S3
		// rejects; an empty body must be http.NoBody.
		req.Body, req.GetBody = http.NoBody, func() (io.ReadCloser, error) { return http.NoBody, nil }
	}
	if contentLength >= 0 {
		req.ContentLength = contentLength
	}
	SignWithHash(req, payloadHash, c.Target.AccessKey, c.Target.SecretKey, c.Target.SigningRegion(), c.Now())
	return client.Do(req)
}

// s3Error turns a failed response into a plain message without credentials.
func (c *S3Client) s3Error(step string, status int, body []byte, err error) error {
	where := c.Target.Describe()
	if err != nil {
		var dns *net.DNSError
		if errors.As(err, &dns) {
			return fmt.Errorf("cannot %s the backup target: the address %s was not found (check the endpoint)", step, c.Target.EndpointHost())
		}
		return fmt.Errorf("cannot %s the backup target: %s did not answer (check the endpoint and the server's outbound network)", step, c.Target.EndpointHost())
	}
	var e struct{ Code, Message string }
	_ = xml.Unmarshal(body, &e)
	switch {
	case e.Code == "NoSuchKey" || (status == 404 && e.Code == "" && strings.HasPrefix(step, "read back")):
		return fmt.Errorf("cannot %s the backup target %s: the object does not exist", step, where)
	case e.Code == "NoSuchBucket" || status == 404:
		return fmt.Errorf("cannot %s the backup target: bucket %q does not exist at %s", step, c.Target.Bucket, c.Target.EndpointHost())
	case e.Code == "InvalidAccessKeyId" || e.Code == "SignatureDoesNotMatch":
		return fmt.Errorf("cannot %s the backup target %s: the access key or secret key is wrong", step, where)
	case e.Code == "AuthorizationHeaderMalformed" || e.Code == "PermanentRedirect" || status == 301:
		return fmt.Errorf("cannot %s the backup target %s: wrong region (set the bucket's region)", step, where)
	case status == 403:
		return fmt.Errorf("cannot %s the backup target %s: access denied (the key needs list, read, write and delete permission on the bucket)", step, where)
	}
	code := e.Code
	if code == "" {
		code = http.StatusText(status)
	}
	if msg := strings.TrimSpace(e.Message); msg != "" && len(msg) <= 200 {
		code += " (" + msg + ")"
	}
	return fmt.Errorf("cannot %s the backup target %s: the store answered %d %s", step, where, status, code)
}

// Probe writes, reads back and deletes a small object under the prefix. It
// is what provisioning and `backup target test` run before trusting a target.
func (c *S3Client) Probe(ctx context.Context) error {
	nonce := make([]byte, 8)
	if _, err := rand.Read(nonce); err != nil {
		return err
	}
	key := c.Target.Key(".platform-probe-" + hex.EncodeToString(nonce))
	payload := []byte("platform backup target probe " + hex.EncodeToString(nonce) + "\n")
	if st, b, err := c.do(ctx, http.MethodPut, key, nil, payload); err != nil || st/100 != 2 {
		return c.s3Error("write to", st, b, err)
	}
	st, b, err := c.do(ctx, http.MethodGet, key, nil, nil)
	if err != nil || st/100 != 2 {
		return c.s3Error("read back from", st, b, err)
	}
	if !bytes.Equal(b, payload) {
		return fmt.Errorf("the backup target %s returned different data than was written", c.Target.Describe())
	}
	if st, b, err := c.do(ctx, http.MethodDelete, key, nil, nil); err != nil || st/100 != 2 {
		return c.s3Error("delete from", st, b, err)
	}
	return nil
}

// ListFolders lists the immediate sub-folders of a prefix (ListObjectsV2 with
// delimiter "/"), e.g. the PostgreSQL archive server names.
func (c *S3Client) ListFolders(ctx context.Context, prefix string) ([]string, error) {
	if prefix = strings.Trim(prefix, "/"); prefix != "" {
		prefix += "/"
	}
	var out []string
	token := ""
	for {
		q := url.Values{"list-type": {"2"}, "delimiter": {"/"}, "prefix": {prefix}}
		if token != "" {
			q.Set("continuation-token", token)
		}
		st, b, err := c.do(ctx, http.MethodGet, "", q, nil)
		if err != nil || st/100 != 2 {
			return nil, c.s3Error("list", st, b, err)
		}
		var r struct {
			CommonPrefixes []struct{ Prefix string }
			IsTruncated    bool
			NextToken      string `xml:"NextContinuationToken"`
		}
		if err := xml.Unmarshal(b, &r); err != nil {
			return nil, fmt.Errorf("the backup target returned an unreadable listing")
		}
		for _, p := range r.CommonPrefixes {
			if name := strings.Trim(strings.TrimPrefix(p.Prefix, prefix), "/"); name != "" {
				out = append(out, name)
			}
		}
		if !r.IsTruncated {
			break
		}
		if r.NextToken == "" || r.NextToken == token {
			return nil, fmt.Errorf("the backup target returned a truncated listing without a new continuation token")
		}
		token = r.NextToken
	}
	return out, nil
}
