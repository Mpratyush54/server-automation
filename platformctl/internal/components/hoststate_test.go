package components

import (
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
)

// sandboxHostState points the break-glass copy at dir and replaces Secret
// reads with `secrets` (nil = every Secret absent). Tests never touch
// /etc/platform or a real cluster.
func sandboxHostState(t *testing.T, dir string, secrets map[string]map[string]string) {
	t.Helper()
	oldDir, oldEnv, oldCred, oldKey, oldRead := hostDir, hostEnvFile, hostCredDir, hostOIDCKeyFile, readSecret
	hostDir = dir
	hostEnvFile = filepath.Join(dir, ".env")
	hostCredDir = filepath.Join(dir, "credentials")
	hostOIDCKeyFile = filepath.Join(dir, "oidc-signing-key.pem")
	readSecret = func(ns, name string) (map[string]string, bool, error) {
		if s, ok := secrets[ns+"/"+name]; ok {
			return s, true, nil
		}
		return nil, false, nil
	}
	t.Cleanup(func() {
		hostDir, hostEnvFile, hostCredDir, hostOIDCKeyFile, readSecret = oldDir, oldEnv, oldCred, oldKey, oldRead
	})
}

func TestReconcileCredentialsPrefersClusterValues(t *testing.T) {
	cfg := &config.Config{PostgresPassword: "host-pg", RedisPassword: "host-rd", AdminPassword: "host-admin", WebhookSecret: "host-hook"}
	changed := reconcileCredentials(cfg,
		map[string]string{"POSTGRES_PASSWORD": "env-pg", "REDIS_PASSWORD": "env-rd", "PLATFORM_WEBHOOK_SECRET": "rotated-hook"},
		map[string]string{"POSTGRES_PASSWORD": "rotated-pg", "ADMIN_PASSWORD": "rotated-admin"},
	)
	if cfg.PostgresPassword != "rotated-pg" {
		t.Errorf("platform-credentials must win: %q", cfg.PostgresPassword)
	}
	if cfg.RedisPassword != "env-rd" {
		t.Errorf("legacy platform-env value must be adopted: %q", cfg.RedisPassword)
	}
	if cfg.AdminPassword != "rotated-admin" || cfg.WebhookSecret != "rotated-hook" {
		t.Errorf("admin/webhook not adopted: %+v", cfg)
	}
	if len(changed) != 4 {
		t.Errorf("changed = %v", changed)
	}
}

func TestReconcileCredentialsKeepsHostWhenClusterEmpty(t *testing.T) {
	cfg := &config.Config{PostgresPassword: "host-pg", RedisPassword: "host-rd"}
	if changed := reconcileCredentials(cfg, nil, map[string]string{"POSTGRES_PASSWORD": "  "}); len(changed) != 0 {
		t.Fatalf("changed = %v", changed)
	}
	if cfg.PostgresPassword != "host-pg" || cfg.RedisPassword != "host-rd" {
		t.Fatalf("host values lost: %+v", cfg)
	}
}

// An upgrade of an install whose passwords were rotated from the portal must
// not change any password: the stale host copy is refreshed from the cluster
// and platform-credentials is applied with the live values.
func TestMigrateHostStateKeepsRotatedPasswords(t *testing.T) {
	calls := fakeTools(t)
	dir := t.TempDir()
	sandboxHostState(t, dir, map[string]map[string]string{
		"platform/platform-env": {"POSTGRES_PASSWORD": "rotated-pg", "REDIS_PASSWORD": "rotated-rd", "ADMIN_PASSWORD": "rotated-admin", "PLATFORM_WEBHOOK_SECRET": "rotated-hook"},
	})
	if err := os.WriteFile(hostEnvFile, []byte("POSTGRES_PASSWORD=stale-pg\n"), 0600); err != nil {
		t.Fatal(err)
	}
	cfg := &config.Config{PostgresPassword: "stale-pg", RedisPassword: "stale-rd", AdminPassword: "stale-admin", WebhookSecret: "stale-hook", MongoPassword: "m", MinioAccessKey: "ak", MinioSecretKey: "sk"}
	if err := MigrateHostState(cfg); err != nil {
		t.Fatal(err)
	}
	var creds map[string]string
	var oidc map[string]string
	for _, c := range calls() {
		var s struct {
			Kind       string
			Metadata   struct{ Name string }
			StringData map[string]string
		}
		if json.Unmarshal([]byte(c.Input), &s) == nil && s.Kind == "Secret" {
			switch s.Metadata.Name {
			case platformCredsSecret:
				creds = s.StringData
			case platformOIDCKeySecret:
				oidc = s.StringData
			}
		}
	}
	if creds == nil {
		t.Fatal("platform-credentials not applied")
	}
	for k, want := range map[string]string{"POSTGRES_PASSWORD": "rotated-pg", "REDIS_PASSWORD": "rotated-rd", "ADMIN_PASSWORD": "rotated-admin", "MINIO_SECRET_KEY": "sk"} {
		if creds[k] != want {
			t.Errorf("%s = %q, want %q", k, creds[k], want)
		}
	}
	env, _ := os.ReadFile(hostEnvFile)
	if !strings.Contains(string(env), "POSTGRES_PASSWORD=rotated-pg") || !strings.Contains(string(env), "PLATFORM_WEBHOOK_SECRET=rotated-hook") {
		t.Errorf("break-glass .env not refreshed:\n%s", env)
	}
	if pg, _ := os.ReadFile(filepath.Join(hostCredDir, "postgres")); strings.TrimSpace(string(pg)) != "rotated-pg" {
		t.Errorf("credentials/postgres = %q", pg)
	}
	if oidc == nil || !strings.Contains(oidc[oidcSecretPrivateKey], "PRIVATE KEY") || oidc[oidcSecretKid] == "" {
		t.Fatal("OIDC signing key secret not created")
	}
	if key, _ := os.ReadFile(hostOIDCKeyFile); string(key) != oidc[oidcSecretPrivateKey] {
		t.Error("break-glass copy of the OIDC key not written")
	}
}

func TestMigrateHostStateRefusesWhenSecretsUnreadable(t *testing.T) {
	calls := fakeTools(t)
	sandboxHostState(t, t.TempDir(), nil)
	readSecret = func(ns, name string) (map[string]string, bool, error) {
		return nil, false, errors.New("connection refused")
	}
	if err := MigrateHostState(&config.Config{PostgresPassword: "stale"}); err == nil {
		t.Fatal("expected refusal")
	}
	for _, c := range calls() {
		if strings.Contains(c.Input, `"kind":"Secret"`) {
			t.Fatal("must not apply any Secret when the live values are unknown")
		}
	}
}

func TestEnsureOIDCKeySecretSeedsFromLegacyHostFile(t *testing.T) {
	sandboxHostState(t, t.TempDir(), nil)
	legacy, err := generateRSAKeyPEM()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(hostOIDCKeyFile, []byte(legacy), 0600); err != nil {
		t.Fatal(err)
	}
	var created map[string]string
	old := createSecretIfAbsent
	createSecretIfAbsent = func(ns, name string, v map[string]string) error { created = v; return nil }
	t.Cleanup(func() { createSecretIfAbsent = old })
	if err := ensureOIDCKeySecret(); err != nil {
		t.Fatal(err)
	}
	if created[oidcSecretPrivateKey] != legacy {
		t.Fatal("existing tokens would break: the legacy key must be reused")
	}
	if kid, _ := oidcKid(legacy); created[oidcSecretKid] != kid {
		t.Fatalf("kid %q != %q", created[oidcSecretKid], kid)
	}
}

func TestEnsureOIDCKeySecretNeverReplacesExistingKey(t *testing.T) {
	sandboxHostState(t, t.TempDir(), map[string]map[string]string{
		"platform/" + platformOIDCKeySecret: {oidcSecretPrivateKey: "-----BEGIN PRIVATE KEY-----\nrotated\n-----END PRIVATE KEY-----\n"},
	})
	old := createSecretIfAbsent
	createSecretIfAbsent = func(string, string, map[string]string) error { t.Fatal("must not overwrite"); return nil }
	t.Cleanup(func() { createSecretIfAbsent = old })
	if err := ensureOIDCKeySecret(); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(hostOIDCKeyFile); !strings.Contains(string(b), "rotated") {
		t.Fatal("break-glass copy should follow the Secret")
	}
}

// Cross-checked against the API's lib/oidc-keys.ts thumbprint for this key.
func TestOIDCKidMatchesAPI(t *testing.T) {
	const pub = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDRM3G+MW4VZwXKTRgiX8pHY6GW
PwpszLQjod6Tiqt+vFUljMzV32MLdcS1IyVlqUOkocsQibRi8xj6csEq50l5Q7Eu
3pxDCuXbfJOs2Zl+6SnDOmkFuo6rwUuiB+Znxx9r+1BhYdsyPbEMFhuHqjVbTr0n
ml9ynw4waVls2VqgIQIDAQAB
-----END PUBLIC KEY-----`
	block, _ := pem.Decode([]byte(pub))
	k, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	if got := jwkThumbprintKid(k.(*rsa.PublicKey)); got != "i0LWuD0y2jn-7UJE" {
		t.Fatalf("kid = %q", got)
	}
}

func TestCredentialKeyRemovalsOnlyWhenCredentialsHoldThem(t *testing.T) {
	env := map[string]string{"POSTGRES_PASSWORD": "p", "REDIS_PASSWORD": "r", "DOMAIN": "d"}
	ops := credentialKeyRemovals(env, map[string]string{"POSTGRES_PASSWORD": "p", "REDIS_PASSWORD": ""})
	if len(ops) != 1 || ops[0]["path"] != "/data/POSTGRES_PASSWORD" || ops[0]["op"] != "remove" {
		t.Fatalf("ops = %v", ops)
	}
}

func TestStatelessAPIPatchDropsHostPath(t *testing.T) {
	var p map[string]any
	if err := json.Unmarshal([]byte(statelessAPIPatch), &p); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"name":"platform-etc","$patch":"delete"`, `"mountPath":"/etc/platform","$patch":"delete"`, `{"secretRef":{"name":"platform-credentials"}}`} {
		if !strings.Contains(statelessAPIPatch, want) {
			t.Errorf("patch missing %s", want)
		}
	}
}

func TestDecodeSecretJSON(t *testing.T) {
	got, found, err := decodeSecretJSON([]byte(`{"data":{"A":"aGk="}}`))
	if err != nil || !found || got["A"] != "hi" {
		t.Fatalf("got %v %v %v", got, found, err)
	}
	if _, _, err := decodeSecretJSON([]byte(``)); err == nil {
		t.Fatal("empty output must be an error, not 'absent'")
	}
}

func TestRecoverWritesPlatformCredentials(t *testing.T) {
	for _, want := range []string{"patch secret platform-credentials", "set_platform_credential POSTGRES_PASSWORD", "set_platform_credential REDIS_PASSWORD", "set_platform_credential ADMIN_PASSWORD"} {
		if !strings.Contains(recoverScript, want) {
			t.Errorf("recover script missing %q", want)
		}
	}
}
