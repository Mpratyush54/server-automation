package components

import (
	"bytes"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"

	"github.com/fatih/color"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/shell"
)

// Kubernetes Secrets the API reads its configuration from (issue #20). The
// running API never touches /etc/platform; platformctl keeps those host files
// as a root-only break-glass copy used by `platformctl recover`.
const (
	platformNamespace      = "platform"
	platformEnvSecret      = "platform-env"              // non-credential config
	platformCredsSecret    = "platform-credentials"      // admin + datastore credentials
	platformOIDCKeySecret  = "platform-oidc-signing-key" // private.pem, kid (+ previous.pem after rotation)
	defaultHostDir         = "/etc/platform"
	defaultHostOIDCKeyFile = "/etc/platform/oidc-signing-key.pem"
	oidcSecretPrivateKey   = "private.pem"
	oidcSecretKid          = "kid"
)

// credentialKeys live in platform-credentials, not platform-env.
var credentialKeys = []string{
	"ADMIN_PASSWORD", "POSTGRES_PASSWORD", "REDIS_PASSWORD",
	"MONGODB_URI", "MINIO_ACCESS_KEY", "MINIO_SECRET_KEY",
}

func mongoURI(cfg *config.Config) string {
	return "mongodb://root:" + url.QueryEscape(cfg.MongoPassword) + "@mongodb.databases:27017/platform?authSource=admin"
}

// credentialValues renders the platform-credentials Secret from config.
func credentialValues(cfg *config.Config) map[string]string {
	return map[string]string{
		"ADMIN_PASSWORD":    cfg.AdminPassword,
		"POSTGRES_PASSWORD": cfg.PostgresPassword,
		"REDIS_PASSWORD":    cfg.RedisPassword,
		"MONGODB_URI":       mongoURI(cfg),
		"MINIO_ACCESS_KEY":  cfg.MinioAccessKey,
		"MINIO_SECRET_KEY":  cfg.MinioSecretKey,
	}
}

// errSecretRead means the cluster could not be asked (as opposed to "absent").
var errSecretRead = errors.New("could not read secret")

// readSecret returns the decoded data of a Secret. found=false means it does
// not exist; an error means we could not find out — callers must then refuse
// to overwrite anything, or a transient kubectl failure would clobber a
// password the API rotated.
var readSecret = func(ns, name string) (map[string]string, bool, error) {
	cmd := exec.Command("kubectl", "-n", ns, "get", "secret", name, "-o", "json")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if strings.Contains(stderr.String(), "NotFound") || strings.Contains(stderr.String(), "not found") {
			return nil, false, nil
		}
		return nil, false, fmt.Errorf("%w %s/%s: %v: %s", errSecretRead, ns, name, err, strings.TrimSpace(stderr.String()))
	}
	return decodeSecretJSON(stdout.Bytes())
}

func decodeSecretJSON(raw []byte) (map[string]string, bool, error) {
	var s struct {
		Data map[string]string `json:"data"`
	}
	if err := json.Unmarshal(raw, &s); err != nil {
		return nil, false, fmt.Errorf("%w: %v", errSecretRead, err)
	}
	out := make(map[string]string, len(s.Data))
	for k, v := range s.Data {
		b, err := base64.StdEncoding.DecodeString(v)
		if err != nil {
			return nil, false, fmt.Errorf("%w: key %s: %v", errSecretRead, k, err)
		}
		out[k] = string(b)
	}
	return out, true, nil
}

// reconcileCredentials adopts values the API may have changed at runtime
// (secret rotation writes platform-credentials; older APIs wrote
// platform-env). The cluster is authoritative for these: the host copy can
// be stale because the API no longer writes host files. Returns the keys
// that changed in cfg.
func reconcileCredentials(cfg *config.Config, env, creds map[string]string) []string {
	pick := func(k string) string {
		if v := strings.TrimSpace(creds[k]); v != "" {
			return v
		}
		return strings.TrimSpace(env[k])
	}
	var changed []string
	adopt := func(key string, dst *string, live string) {
		if live != "" && live != *dst {
			*dst = live
			changed = append(changed, key)
		}
	}
	adopt("POSTGRES_PASSWORD", &cfg.PostgresPassword, pick("POSTGRES_PASSWORD"))
	adopt("REDIS_PASSWORD", &cfg.RedisPassword, pick("REDIS_PASSWORD"))
	adopt("ADMIN_PASSWORD", &cfg.AdminPassword, pick("ADMIN_PASSWORD"))
	adopt("PLATFORM_WEBHOOK_SECRET", &cfg.WebhookSecret, strings.TrimSpace(env["PLATFORM_WEBHOOK_SECRET"]))
	return changed
}

// hostPaths are overridable in tests.
var (
	hostDir         = defaultHostDir
	hostEnvFile     = defaultEnvFile
	hostCredDir     = defaultCredDir
	hostOIDCKeyFile = defaultHostOIDCKeyFile
)

// SyncCredentialsFromCluster pulls runtime-changed credentials from the
// Secrets into cfg and refreshes the host break-glass copy. It never writes
// to the cluster.
func SyncCredentialsFromCluster(cfg *config.Config) error {
	env, _, err := readSecret(platformNamespace, platformEnvSecret)
	if err != nil {
		return err
	}
	creds, _, err := readSecret(platformNamespace, platformCredsSecret)
	if err != nil {
		return err
	}
	if changed := reconcileCredentials(cfg, env, creds); len(changed) > 0 {
		sort.Strings(changed)
		color.Cyan("  · adopted current cluster values for %s (rotated at runtime)", strings.Join(changed, ", "))
	}
	return writeHostCopy(cfg)
}

// writeHostCopy writes the root-only break-glass copy under /etc/platform.
func writeHostCopy(cfg *config.Config) error {
	if err := os.MkdirAll(hostDir, 0700); err != nil {
		return fmt.Errorf("create %s: %w", hostDir, err)
	}
	if err := cfg.SaveEnvFile(hostEnvFile); err != nil {
		return fmt.Errorf("write %s: %w", hostEnvFile, err)
	}
	if err := PersistLocalCredentials(hostEnvFile, hostCredDir, map[string]string{
		"POSTGRES_PASSWORD": cfg.PostgresPassword,
		"REDIS_PASSWORD":    cfg.RedisPassword,
		"ADMIN_PASSWORD":    cfg.AdminPassword,
	}); err != nil {
		return err
	}
	secureHostDir(hostDir)
	return nil
}

// secureHostDir makes the break-glass copy root-only. Older installs made it
// group-writable for uid 1000 so the API pod could write it via hostPath.
func secureHostDir(dir string) {
	_ = filepath.Walk(dir, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		_ = os.Lchown(p, 0, 0)
		if info.IsDir() {
			_ = os.Chmod(p, 0700)
		} else if info.Mode().IsRegular() {
			_ = os.Chmod(p, 0600)
		}
		return nil
	})
}

// MigrateHostState moves the API's configuration into Kubernetes Secrets on
// provision/update without changing any password:
//  1. read the live Secrets (refusing to continue if they cannot be read);
//  2. adopt runtime-rotated values into cfg and refresh /etc/platform (break-glass);
//  3. apply platform-credentials from the reconciled values;
//  4. seed platform-oidc-signing-key from /etc/platform/oidc-signing-key.pem
//     (or generate one) when the Secret does not exist yet.
func MigrateHostState(cfg *config.Config) error {
	color.Cyan("  ■ Syncing platform configuration into Kubernetes Secrets...")
	if err := SyncCredentialsFromCluster(cfg); err != nil {
		return fmt.Errorf("refusing to update credentials: %w", err)
	}
	if err := applySecret(platformNamespace, platformCredsSecret, credentialValues(cfg)); err != nil {
		return err
	}
	if err := ensureOIDCKeySecret(); err != nil {
		return err
	}
	color.Green("  ✓ Secrets %s, %s and %s are current", platformEnvSecret, platformCredsSecret, platformOIDCKeySecret)
	return nil
}

// createSecretIfAbsent is overridable in tests.
var createSecretIfAbsent = func(ns, name string, values map[string]string) error {
	return applySecret(ns, name, values)
}

// ensureOIDCKeySecret creates the signing-key Secret once (from the legacy
// host file when present, so tokens issued before the upgrade stay valid)
// and keeps a host copy of the current key for break-glass.
func ensureOIDCKeySecret() error {
	data, found, err := readSecret(platformNamespace, platformOIDCKeySecret)
	if err != nil {
		return err
	}
	if !found || strings.TrimSpace(data[oidcSecretPrivateKey]) == "" {
		pemText, source := "", "generated"
		if raw, err := os.ReadFile(hostOIDCKeyFile); err == nil && strings.TrimSpace(string(raw)) != "" {
			pemText, source = string(raw), hostOIDCKeyFile
		} else {
			if pemText, err = generateRSAKeyPEM(); err != nil {
				return err
			}
		}
		kid, err := oidcKid(pemText)
		if err != nil {
			return fmt.Errorf("OIDC signing key from %s: %w", source, err)
		}
		if err := createSecretIfAbsent(platformNamespace, platformOIDCKeySecret, map[string]string{
			oidcSecretPrivateKey: pemText, oidcSecretKid: kid,
		}); err != nil {
			return err
		}
		color.Green("  ✓ OIDC signing key stored in secret %s (from %s, kid %s)", platformOIDCKeySecret, source, kid)
		data = map[string]string{oidcSecretPrivateKey: pemText}
	}
	// Break-glass copy of the key currently in use.
	if cur, err := os.ReadFile(hostOIDCKeyFile); err != nil || string(cur) != data[oidcSecretPrivateKey] {
		_ = config.WriteFileSync(hostOIDCKeyFile, data[oidcSecretPrivateKey], 0600)
	}
	return nil
}

func generateRSAKeyPEM() (string, error) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return "", err
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return "", err
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})), nil
}

// oidcKid mirrors the API (lib/oidc-keys.ts): RFC 7638 JWK thumbprint,
// base64url, first 16 characters.
func oidcKid(pemText string) (string, error) {
	block, _ := pem.Decode([]byte(pemText))
	if block == nil {
		return "", fmt.Errorf("not PEM")
	}
	var pub *rsa.PublicKey
	if k, err := x509.ParsePKCS8PrivateKey(block.Bytes); err == nil {
		rk, ok := k.(*rsa.PrivateKey)
		if !ok {
			return "", fmt.Errorf("not an RSA key")
		}
		pub = &rk.PublicKey
	} else if rk, err2 := x509.ParsePKCS1PrivateKey(block.Bytes); err2 == nil {
		pub = &rk.PublicKey
	} else {
		return "", fmt.Errorf("parse private key: %v", err)
	}
	return jwkThumbprintKid(pub), nil
}

func jwkThumbprintKid(pub *rsa.PublicKey) string {
	b64 := base64.RawURLEncoding.EncodeToString
	e := b64(big.NewInt(int64(pub.E)).Bytes())
	n := b64(pub.N.Bytes())
	sum := sha256.Sum256([]byte(`{"e":"` + e + `","kty":"RSA","n":"` + n + `"}`))
	return b64(sum[:])[:16]
}

// statelessAPIPatch removes the legacy /etc/platform hostPath and makes the
// API read credentials from platform-credentials (after platform-env, so
// credentials win if a key is still present in both).
const statelessAPIPatch = `{"spec":{"template":{"spec":{` +
	`"volumes":[{"name":"platform-etc","$patch":"delete"}],` +
	`"containers":[{"name":"api",` +
	`"envFrom":[{"secretRef":{"name":"platform-env"}},{"secretRef":{"name":"platform-credentials"}}],` +
	`"volumeMounts":[{"mountPath":"/etc/platform","$patch":"delete"}]}]}}}}`

// PrepareUpdate runs before `platformctl update` rolls images: it migrates
// host state into Secrets, applies the API RBAC (access to its own Secrets)
// and removes the hostPath volume from an existing Deployment.
func PrepareUpdate(cfg *config.Config) error {
	if err := MigrateHostState(cfg); err != nil {
		return err
	}
	if err := applyAPIRBAC(); err != nil {
		return err
	}
	if err := shell.RunBash(`set -euo pipefail
export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
kubectl -n platform get deployment platform-api >/dev/null 2>&1 || exit 0
kubectl -n platform patch deployment platform-api --type strategic -p ` + shellQuote(statelessAPIPatch) + ` >/dev/null
kubectl -n platform rollout status deployment/platform-api --timeout=300s`); err != nil {
		return fmt.Errorf("remove hostPath from platform-api: %w", err)
	}
	return stripCredentialKeysFromEnvSecret()
}

func applyAPIRBAC() error {
	rbac := readManifest("platform-api-rbac.yaml")
	if rbac == "" {
		return fmt.Errorf("platform-api RBAC manifest missing")
	}
	_, err := shell.RunWithInput("kubectl", []string{"apply", "-f", "-"}, rbac)
	return err
}

// stripCredentialKeysFromEnvSecret removes credential keys from platform-env
// once platform-credentials holds them (kubectl apply never removes keys
// that were dropped from stringData). Only runs when the credentials Secret
// has every key, so nothing is ever lost.
func stripCredentialKeysFromEnvSecret() error {
	creds, found, err := readSecret(platformNamespace, platformCredsSecret)
	if err != nil || !found {
		return err
	}
	env, found, err := readSecret(platformNamespace, platformEnvSecret)
	if err != nil || !found {
		return err
	}
	ops := credentialKeyRemovals(env, creds)
	if len(ops) == 0 {
		return nil
	}
	patch, _ := json.Marshal(ops)
	if _, err := shell.RunWithInput("kubectl", []string{"-n", platformNamespace, "patch", "secret", platformEnvSecret, "--type", "json", "--patch-file", "/dev/stdin"}, string(patch)); err != nil {
		return fmt.Errorf("remove credential keys from %s: %w", platformEnvSecret, err)
	}
	return nil
}

// credentialKeyRemovals returns JSON-patch remove ops for credential keys in
// platform-env that platform-credentials already holds (non-empty).
func credentialKeyRemovals(env, creds map[string]string) []map[string]string {
	var ops []map[string]string
	for _, k := range credentialKeys {
		if _, inEnv := env[k]; !inEnv {
			continue
		}
		if strings.TrimSpace(creds[k]) == "" {
			continue
		}
		ops = append(ops, map[string]string{"op": "remove", "path": "/data/" + k})
	}
	return ops
}
