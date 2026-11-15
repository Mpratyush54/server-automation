package components

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"strings"
	"testing"
	"time"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/manifests"
)

func testCAPEM(t *testing.T) (cert, key string) {
	t.Helper()
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "Platform Internal CA"}, NotBefore: time.Now(), NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &k.PublicKey, k)
	if err != nil {
		t.Fatal(err)
	}
	kb, _ := x509.MarshalECPrivateKey(k)
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})), string(pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kb}))
}

type minioCAFake struct {
	platformCA string
	published  string
	applied    int
	restarted  int
	installed  bool
}

func stubMinioCA(t *testing.T, f *minioCAFake) {
	t.Helper()
	oldRead, oldReadMinio, oldApply, oldInstalled, oldRestart, oldWait, oldPoll := readPlatformCA, readMinioCA, applyMinioCA, minioInstalled, restartMinio, caWaitTimeout, caPollEvery
	t.Cleanup(func() {
		readPlatformCA, readMinioCA, applyMinioCA, minioInstalled, restartMinio, caWaitTimeout, caPollEvery = oldRead, oldReadMinio, oldApply, oldInstalled, oldRestart, oldWait, oldPoll
	})
	readPlatformCA = func() string { return f.platformCA }
	readMinioCA = func() string { return f.published }
	applyMinioCA = func(cm map[string]any) error {
		f.applied++
		f.published = cm["data"].(map[string]string)["ca.crt"]
		return nil
	}
	minioInstalled = func() bool { return f.installed }
	restartMinio = func() error { f.restarted++; return nil }
	caWaitTimeout, caPollEvery = 20*time.Millisecond, time.Millisecond
}

func TestMinioCAConfigMapCarriesOnlyTheCertificate(t *testing.T) {
	cert, key := testCAPEM(t)
	cm := minioCAConfigMap(cert + key)
	if cm == nil {
		t.Fatal("no ConfigMap for a valid CA")
	}
	meta := cm["metadata"].(map[string]any)
	if meta["name"] != MinioCAConfigMap || meta["namespace"] != MinioNamespace {
		t.Fatalf("metadata: %v", meta)
	}
	got := cm["data"].(map[string]string)["ca.crt"]
	if got != cert || strings.Contains(got, "PRIVATE KEY") {
		t.Fatalf("ConfigMap must hold only the CA certificate: %q", got)
	}
	if minioCAConfigMap("") != nil || minioCAConfigMap("not pem") != nil {
		t.Fatal("ConfigMap rendered without a certificate")
	}
}

func TestTrustMinioCARestartsOnlyWhenTheInternalCAIsNewlyTrusted(t *testing.T) {
	cert, _ := testCAPEM(t)
	f := &minioCAFake{platformCA: cert, installed: true}
	stubMinioCA(t, f)

	// Fallback to the internal CA on an install whose MinIO lacked the copy.
	if err := trustMinioCA(true); err != nil {
		t.Fatal(err)
	}
	if f.applied != 1 || f.restarted != 1 {
		t.Fatalf("applied=%d restarted=%d", f.applied, f.restarted)
	}
	// Re-runs (repair, routing again) change nothing and do not restart.
	if err := trustMinioCA(true); err != nil {
		t.Fatal(err)
	}
	if f.applied != 1 || f.restarted != 1 {
		t.Fatalf("idempotent re-run: applied=%d restarted=%d", f.applied, f.restarted)
	}
	// Let's Encrypt active: keep the copy current, never restart for it.
	other, _ := testCAPEM(t)
	f.platformCA = other
	if err := trustMinioCA(false); err != nil {
		t.Fatal(err)
	}
	if f.applied != 2 || f.restarted != 1 {
		t.Fatalf("LE mode: applied=%d restarted=%d", f.applied, f.restarted)
	}
}

func TestTrustMinioCAWithoutCAOrMinio(t *testing.T) {
	f := &minioCAFake{}
	stubMinioCA(t, f)
	if err := trustMinioCA(true); err != nil || f.applied != 0 || f.restarted != 0 {
		t.Fatalf("no CA: err=%v applied=%d restarted=%d", err, f.applied, f.restarted)
	}
	cert, _ := testCAPEM(t)
	f.platformCA = cert
	if err := trustMinioCA(true); err != nil || f.applied != 1 || f.restarted != 0 {
		t.Fatalf("MinIO not installed: err=%v applied=%d restarted=%d", err, f.applied, f.restarted)
	}
}

func TestPrepareMinioCAPublishesBeforeInstall(t *testing.T) {
	cert, _ := testCAPEM(t)
	f := &minioCAFake{platformCA: cert}
	stubMinioCA(t, f)
	prepareMinioCA()
	if f.published != cert || f.restarted != 0 {
		t.Fatalf("published=%q restarted=%d", f.published, f.restarted)
	}
	// No CA yet: gives up after the wait, without failing the install.
	g := &minioCAFake{}
	stubMinioCA(t, g)
	prepareMinioCA()
	if g.applied != 0 {
		t.Fatal("published without a CA")
	}
}

func TestMinioValuesTrustTheInternalCA(t *testing.T) {
	raw, err := manifests.Read("minio-values.yaml")
	if err != nil {
		t.Fatal(err)
	}
	v := string(raw)
	// Server and console: the CA directory joins the system roots, from the
	// optional ConfigMap platformctl publishes.
	if strings.Count(v, "value: /etc/ssl/certs:/etc/platform-ca") != 2 {
		t.Fatal("SSL_CERT_DIR must list the system roots and the CA mount for the server and the console")
	}
	if strings.Count(v, "name: platform-ca\n") < 4 || strings.Count(v, "optional: true") != 2 || strings.Count(v, "mountPath: /etc/platform-ca") != 2 {
		t.Fatalf("platform-ca volume/mount missing for server or console:\n%s", v)
	}
	if MinioCAConfigMap != "platform-ca" {
		t.Fatal("values reference ConfigMap platform-ca")
	}
}
