package components

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/k3s"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/shell"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/state"
)

const BuildRegistryImage = "registry:2.8.3"

// Registry token authorization: the API signs short-lived JWTs scoped to exact
// repositories; the registry trusts only the matching certificate. The values
// mirror platform/api/src/lib/registry-token.ts.
const (
	RegistryTokenService = "cairn-registry"
	RegistryTokenIssuer  = "cairn-api"
)

// BuildKit runtime profiles: installed on the node and referenced by the API's
// build Job (platform/api/src/lib/build-spec.ts) for the BuildKit container only.
const (
	BuildRuntimeLabel           = "cairn.dev/build-runtime"
	BuildRuntimeVersion         = "v1"
	BuildkitSeccompProfilePath  = "/var/lib/kubelet/seccomp/cairn/buildkit-v1.json"
	BuildkitAppArmorProfileName = "cairn-buildkit-v1"
	buildkitAppArmorProfilePath = "/etc/apparmor.d/cairn-buildkit-v1"
)

// buildBlockedNetworks are always excluded from build egress, whatever the
// operator allows: private, loopback, link-local (cloud metadata), CGNAT,
// multicast/reserved, and the cluster pod and service CIDRs. Mirrors
// privateNetworks in platform/api/src/lib/namespace-baseline.ts.
var buildBlockedNetworks = []string{"10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8", "169.254.0.0/16", "100.64.0.0/10", "0.0.0.0/8", "224.0.0.0/4", "240.0.0.0/4", "10.42.0.0/16", "10.43.0.0/16"}

var bucketName = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$`)

func BuildsEnabled(c *config.Config) bool {
	return c.BuildsEnabled && c.Profile != config.ProfileMinimal
}

func registryBucket(c *config.Config) string {
	if c.BuildsS3Bucket == "" {
		return "platform-registry"
	}
	return c.BuildsS3Bucket
}

// RegistryTokenRealm is the token endpoint containerd calls from the node: the
// API Service ClusterIP (node DNS cannot resolve cluster names).
func RegistryTokenRealm(apiClusterIP string) (string, error) {
	addr, err := netip.ParseAddr(strings.TrimSpace(apiClusterIP))
	if err != nil {
		return "", fmt.Errorf("platform API ClusterIP unavailable")
	}
	return "http://" + net.JoinHostPort(addr.String(), "3000") + "/api/registry/token", nil
}

func validRealm(realm string) bool {
	u, err := url.Parse(realm)
	if err != nil || u.Scheme != "http" || u.Port() != "3000" || u.Path != "/api/registry/token" || u.User != nil || u.RawQuery != "" {
		return false
	}
	_, err = netip.ParseAddr(u.Hostname())
	return err == nil
}

func cidrList(value, name string) ([]netip.Prefix, error) {
	var out []netip.Prefix
	for _, raw := range strings.Split(value, ",") {
		if strings.TrimSpace(raw) == "" {
			continue
		}
		prefix, err := netip.ParsePrefix(strings.TrimSpace(raw))
		if err != nil || prefix != prefix.Masked() {
			return nil, fmt.Errorf("%s must list network CIDRs", name)
		}
		out = append(out, prefix)
	}
	return out, nil
}

// BuildRegistryManifest contains no credentials. S3 credentials and the token
// certificate are supplied by Secrets, including when an operator selects
// external S3. The registry is reachable only in-cluster: builds push to it, the
// API manages retention, and node containerd pulls through the Service
// ClusterIP. There is no Ingress.
func BuildRegistryManifest(c *config.Config, realm string) (string, error) {
	if !BuildsEnabled(c) {
		return "", nil
	}
	if !regexp.MustCompile(`^[A-Za-z0-9.-]+$`).MatchString(c.Domain) {
		return "", fmt.Errorf("invalid registry domain")
	}
	if !validRealm(realm) {
		return "", fmt.Errorf("invalid registry token realm")
	}
	endpoint := c.BuildsS3Endpoint
	if endpoint == "" {
		endpoint = "http://minio.storage.svc:9000"
	}
	if c.BuildsS3Endpoint != "" {
		parsed, err := url.Parse(endpoint)
		if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
			return "", fmt.Errorf("external build storage requires an HTTPS endpoint without credentials")
		}
	}
	bucket := registryBucket(c)
	if !bucketName.MatchString(bucket) {
		return "", fmt.Errorf("invalid registry bucket name")
	}
	if strings.ContainsAny(endpoint, "\n\r\"\\") {
		return "", fmt.Errorf("invalid registry storage setting")
	}
	nodes, err := cidrList(c.BuildsRegistryNodeCIDRs, "BUILDS_REGISTRY_NODE_CIDRS")
	if err != nil {
		return "", err
	}
	var nodePeers strings.Builder
	for _, prefix := range nodes {
		fmt.Fprintf(&nodePeers, "    - ipBlock: {cidr: %s}\n", prefix.String())
	}
	return fmt.Sprintf(`apiVersion: v1
kind: Namespace
metadata:
  name: registry
  labels:
    pod-security.kubernetes.io/enforce: restricted
---
apiVersion: v1
kind: ConfigMap
metadata: {name: registry, namespace: registry}
data:
  config.yml: |
    version: 0.1
    log: {level: warn}
    storage:
      s3:
        region: us-east-1
        regionendpoint: %q
        bucket: %q
        secure: %t
        forcepathstyle: true
        v4auth: true
      delete: {enabled: true}
      redirect: {disable: true}
    http: {addr: ':5000'}
    auth:
      token:
        realm: %q
        service: %s
        issuer: %s
        rootcertbundle: /token/cert.pem
---
apiVersion: apps/v1
kind: Deployment
metadata: {name: registry, namespace: registry}
spec:
  replicas: 1
  selector: {matchLabels: {app: registry}}
  template:
    metadata:
      labels: {app: registry}
      annotations: {cairn.dev/config: "%x"}
    spec:
      automountServiceAccountToken: false
      securityContext: {runAsUser: 1000, runAsGroup: 1000, runAsNonRoot: true, fsGroup: 1000, seccompProfile: {type: RuntimeDefault}}
      containers:
      - name: registry
        image: %s
        args: [serve, /etc/distribution/config.yml]
        envFrom: [{secretRef: {name: registry-storage}}]
        env:
        - name: REGISTRY_HTTP_SECRET
          valueFrom: {secretKeyRef: {name: registry-auth, key: http-secret}}
        ports: [{containerPort: 5000}]
        readinessProbe: {tcpSocket: {port: 5000}}
        resources:
          requests: {cpu: 100m, memory: 128Mi}
          limits: {cpu: '1', memory: 512Mi}
        securityContext: {allowPrivilegeEscalation: false, capabilities: {drop: [ALL]}}
        volumeMounts:
        - {name: config, mountPath: /etc/distribution, readOnly: true}
        - {name: token, mountPath: /token, readOnly: true}
      volumes:
      - {name: config, configMap: {name: registry}}
      - {name: token, secret: {secretName: registry-token-cert, items: [{key: cert.pem, path: cert.pem}]}}
---
apiVersion: v1
kind: Service
metadata: {name: registry, namespace: registry}
spec: {selector: {app: registry}, ports: [{port: 5000, targetPort: 5000}]}
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: {name: registry, namespace: registry}
spec:
  podSelector: {}
  policyTypes: [Ingress]
  ingress:
  - from:
    - namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: builds}}
    - namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: platform}}
      podSelector: {matchLabels: {app: platform-api}}
%s    ports: [{port: 5000, protocol: TCP}]
`, endpoint, bucket, strings.HasPrefix(endpoint, "https:"), realm, RegistryTokenService, RegistryTokenIssuer,
		sha256.Sum256([]byte(endpoint+"\x00"+bucket+"\x00"+realm)), BuildRegistryImage, nodePeers.String()), nil
}

// BuildEgressPeers renders the operator's allowlist with every blocked network
// it contains listed under except. A CIDR inside a blocked network is refused.
func BuildEgressPeers(cidrs string) (string, error) {
	var blocked []netip.Prefix
	for _, b := range buildBlockedNetworks {
		blocked = append(blocked, netip.MustParsePrefix(b))
	}
	var peers strings.Builder
	for _, raw := range strings.Split(cidrs, ",") {
		prefix, err := netip.ParsePrefix(strings.TrimSpace(raw))
		if err != nil || prefix.Bits() == 0 || !prefix.Addr().Is4() || prefix != prefix.Masked() {
			return "", fmt.Errorf("BUILDS_EGRESS_CIDRS must list explicit IPv4 network CIDRs for Git, base images and packages")
		}
		var except []string
		for _, b := range blocked {
			if b.Bits() <= prefix.Bits() && b.Contains(prefix.Addr()) {
				return "", fmt.Errorf("BUILDS_EGRESS_CIDRS may not include private or cluster network %s", prefix)
			}
			if b.Bits() > prefix.Bits() && prefix.Contains(b.Addr()) {
				except = append(except, b.String())
			}
		}
		if len(except) > 0 {
			fmt.Fprintf(&peers, "    - ipBlock: {cidr: %s, except: [%s]}\n", prefix, strings.Join(except, ", "))
		} else {
			fmt.Fprintf(&peers, "    - ipBlock: {cidr: %s}\n", prefix)
		}
	}
	return peers.String(), nil
}

// Egress is an explicit allowlist (HTTPS only) plus DNS and the in-cluster
// registry. Private and cluster ranges are always excluded.
func BuildNamespaceManifest(c *config.Config) (string, error) {
	if !BuildsEnabled(c) {
		return "", nil
	}
	peers, err := BuildEgressPeers(c.BuildsEgressCIDRs)
	if err != nil {
		return "", err
	}
	return `apiVersion: v1
kind: Namespace
metadata:
  name: builds
  labels:
    pod-security.kubernetes.io/enforce: baseline
    pod-security.kubernetes.io/warn: baseline
    pod-security.kubernetes.io/audit: baseline
---
apiVersion: v1
kind: ResourceQuota
metadata: {name: builds, namespace: builds}
spec:
  hard: {requests.cpu: '4', requests.memory: 8Gi, limits.cpu: '32', limits.memory: 48Gi, pods: '8', requests.storage: 10Gi, requests.ephemeral-storage: 16Gi, limits.ephemeral-storage: 100Gi}
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: {name: build-isolation, namespace: builds}
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
  ingress: []
  egress:
  - to:
    - namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: kube-system}}
      podSelector: {matchLabels: {k8s-app: kube-dns}}
    ports: [{port: 53, protocol: UDP}, {port: 53, protocol: TCP}]
  - to:
    - namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: registry}}
      podSelector: {matchLabels: {app: registry}}
    ports: [{port: 5000, protocol: TCP}]
  - to:
` + peers + `    ports: [{port: 443, protocol: TCP}]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: {name: platform-builds, namespace: builds}
rules:
- apiGroups: [batch]
  resources: [jobs]
  verbs: [get, list, create, delete]
- apiGroups: ['']
  resources: [configmaps]
  resourceNames: [build-ca]
  verbs: [get]
- apiGroups: ['']
  resources: [pods, pods/log]
  verbs: [get, list]
# Per-build credential Secrets have generated names, so RBAC cannot list them;
# the admission policy below limits writes and deletes to those names. No
# other Secret is kept in this namespace (the registry signing key lives in
# the platform namespace).
- apiGroups: ['']
  resources: [secrets]
  verbs: [get, create, update, patch, delete]
---
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata: {name: platform-build-secrets}
spec:
  failurePolicy: Fail
  matchConstraints:
    namespaceSelector:
      matchLabels: {kubernetes.io/metadata.name: builds}
    resourceRules:
    - apiGroups: ['']
      apiVersions: [v1]
      operations: [CREATE, UPDATE, DELETE]
      resources: [secrets]
  matchConditions:
  - name: platform-api-only
    expression: "request.userInfo.username == 'system:serviceaccount:platform:platform-api'"
  validations:
  - expression: "(request.operation == 'DELETE' ? oldObject : object).metadata.name.matches('^build-[0-9a-f-]{36}-(git|push)$')"
    message: "The platform API may only manage per-build credential Secrets in the builds namespace"
---
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicyBinding
metadata: {name: platform-build-secrets}
spec:
  policyName: platform-build-secrets
  validationActions: [Deny]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: {name: platform-builds, namespace: builds}
subjects: [{kind: ServiceAccount, name: platform-api, namespace: platform}]
roleRef: {apiGroup: rbac.authorization.k8s.io, kind: Role, name: platform-builds}
`, nil
}

// GenerateRegistryTokenSigner creates the API's ECDSA P-256 signing key and a
// self-signed certificate for the registry's rootcertbundle. The registry
// identifies the key by the certificate's public key (libtrust key ID).
func GenerateRegistryTokenSigner() (keyPEM, certPEM string, err error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return "", "", err
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return "", "", err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 127))
	if err != nil {
		return "", "", err
	}
	now := time.Now()
	tmpl := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: "cairn-registry-token"},
		NotBefore: now.Add(-time.Hour), NotAfter: now.AddDate(10, 0, 0), KeyUsage: x509.KeyUsageDigitalSignature, BasicConstraintsValid: true}
	cert, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return "", "", err
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})), string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert})), nil
}

// RegistryTokenSignerMatches reports whether the certificate belongs to the key.
func RegistryTokenSignerMatches(keyPEM, certPEM string) bool {
	kb, _ := pem.Decode([]byte(keyPEM))
	cb, _ := pem.Decode([]byte(certPEM))
	if kb == nil || cb == nil {
		return false
	}
	parsed, err := x509.ParsePKCS8PrivateKey(kb.Bytes)
	if err != nil {
		return false
	}
	key, ok := parsed.(*ecdsa.PrivateKey)
	cert, err := x509.ParseCertificate(cb.Bytes)
	if !ok || err != nil {
		return false
	}
	pub, ok := cert.PublicKey.(*ecdsa.PublicKey)
	return ok && pub.Equal(&key.PublicKey)
}

// BuildkitSeccompProfile starts from allow-all and denies kernel interfaces a
// build never needs (modules, kexec, keyrings, BPF, perf, ptrace, io_uring,
// clock and swap control, and so on). Unlike RuntimeDefault it permits the
// user-namespace, mount and pivot_root calls rootless BuildKit uses to sandbox
// RUN steps. It applies only to the BuildKit container; the kernel still
// confines those calls to namespaces the container itself created.
// Netfilter netlink sockets are refused: builds have no use for packet
// filtering configuration inside their own network namespace.
// The new mount API (fsopen, fsmount, move_mount, open_tree, ...) stays
// allowed until a real-server run shows the bundled runc does not use it.
const (
	afNetlink        = 16 // AF_NETLINK
	netlinkNetfilter = 12 // NETLINK_NETFILTER
)

func BuildkitSeccompProfile() string {
	deny := []string{"acct", "bpf", "clock_adjtime", "clock_settime", "create_module", "delete_module", "fanotify_init", "finit_module",
		"get_kernel_syms", "get_mempolicy", "init_module", "io_uring_enter", "io_uring_register", "io_uring_setup", "ioperm", "iopl", "kcmp",
		"kexec_file_load", "kexec_load", "lookup_dcookie", "mbind", "migrate_pages", "move_pages", "name_to_handle_at", "nfsservctl",
		"open_by_handle_at", "perf_event_open", "process_vm_readv", "process_vm_writev", "ptrace", "query_module", "quotactl", "quotactl_fd",
		"reboot", "set_mempolicy", "settimeofday", "stime", "swapoff", "swapon", "_sysctl", "sysfs", "syslog", "uselib", "userfaultfd",
		"ustat", "vm86", "vm86old"}
	profile := map[string]any{
		"defaultAction": "SCMP_ACT_ALLOW",
		"architectures": []string{"SCMP_ARCH_X86_64", "SCMP_ARCH_X86", "SCMP_ARCH_X32", "SCMP_ARCH_AARCH64", "SCMP_ARCH_ARM"},
		"syscalls": []map[string]any{
			{"names": deny, "action": "SCMP_ACT_ERRNO", "errnoRet": 1},
			// ENOSYS, not EPERM: runtimes treat a missing keyring API as "not supported".
			{"names": []string{"add_key", "keyctl", "request_key"}, "action": "SCMP_ACT_ERRNO", "errnoRet": 38},
			// socket(AF_NETLINK, *, NETLINK_NETFILTER): EPROTONOSUPPORT. Conditions are ANDed.
			{"names": []string{"socket"}, "action": "SCMP_ACT_ERRNO", "errnoRet": 93, "args": []map[string]any{
				{"index": 0, "value": afNetlink, "op": "SCMP_CMP_EQ"},
				{"index": 2, "value": netlinkNetfilter, "op": "SCMP_CMP_EQ"},
			}},
		},
	}
	data, _ := json.MarshalIndent(profile, "", "  ")
	return string(data) + "\n"
}

// BuildkitAppArmorProfile follows the container runtime's default profile and
// additionally allows creating user namespaces and the mounts rootless BuildKit
// performs inside them (Ubuntu restricts unprivileged user namespaces to
// profiles that allow them). Host /proc and /sys writes stay denied.
func BuildkitAppArmorProfile() string {
	return `abi <abi/4.0>,
include <tunables/global>

profile ` + BuildkitAppArmorProfileName + ` flags=(attach_disconnected,mediate_deleted) {
  include <abstractions/base>

  network,
  capability,
  file,
  umount,
  mount,
  remount,
  pivot_root,
  userns,
  signal (receive) peer=unconfined,
  signal (send,receive) peer=` + BuildkitAppArmorProfileName + `,

  deny @{PROC}/* w,
  deny @{PROC}/{[^1-9],[^1-9][^0-9],[^1-9s][^0-9y][^0-9s],[^1-9][^0-9][^0-9][^0-9/]*}/** w,
  deny @{PROC}/sys/[^k]** w,
  deny @{PROC}/sys/kernel/{?,??,[^s][^h][^m]**} w,
  deny @{PROC}/sysrq-trigger rwklx,
  deny @{PROC}/kcore rwklx,
  deny /sys/[^f]*/** wklx,
  deny /sys/f[^s]*/** wklx,
  deny /sys/fs/[^c]*/** wklx,
  deny /sys/fs/c[^g]*/** wklx,
  deny /sys/fs/cg[^r]*/** wklx,
  deny /sys/firmware/** rwklx,
  deny /sys/kernel/security/** rwklx,
}
`
}

// installBuildRuntime writes the BuildKit profiles on this node and labels it so
// build Jobs schedule only where the profiles exist.
func installBuildRuntime() error {
	enabled, _ := os.ReadFile("/sys/module/apparmor/parameters/enabled")
	if strings.TrimSpace(string(enabled)) != "Y" {
		return fmt.Errorf("source builds require AppArmor on the build node")
	}
	if err := os.MkdirAll(filepath.Dir(BuildkitSeccompProfilePath), 0755); err != nil {
		return err
	}
	if err := os.WriteFile(BuildkitSeccompProfilePath, []byte(BuildkitSeccompProfile()), 0644); err != nil {
		return err
	}
	if err := os.WriteFile(buildkitAppArmorProfilePath, []byte(BuildkitAppArmorProfile()), 0644); err != nil {
		return err
	}
	if err := shell.RunBash("apparmor_parser -r -W " + buildkitAppArmorProfilePath); err != nil {
		return fmt.Errorf("load BuildKit AppArmor profile: %w", err)
	}
	return shell.RunBash(fmt.Sprintf(`set -euo pipefail
export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
host="$(hostname | tr '[:upper:]' '[:lower:]')"
node="$(kubectl get nodes -l "kubernetes.io/hostname=${host}" -o name)"
if [[ -z "$node" ]]; then echo "build node ${host} not found" >&2; exit 1; fi
kubectl label "$node" %s=%s --overwrite >/dev/null
`, BuildRuntimeLabel, BuildRuntimeVersion))
}

func clusterIP(namespace, service string) string {
	out, err := shell.OutputBash(fmt.Sprintf(`export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
kubectl -n %s get svc %s -o jsonpath='{.spec.clusterIP}' 2>/dev/null || true`, namespace, service))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(out)
}

// RegistrySignerNamespace holds the API's registry signing key. It is kept out
// of the builds namespace, where repository code runs; the API reads it through
// a resourceNames-scoped rule (platform-api-rbac.yaml).
const RegistrySignerNamespace = "platform"

// chooseRegistrySigner returns the signing key to keep: the current one, or
// the one an earlier version stored in the builds namespace, if it still
// matches the registry's certificate. ok=false means a new pair is needed.
func chooseRegistrySigner(current, legacy, cert string) (key string, ok bool) {
	for _, k := range []string{current, legacy} {
		if k != "" && cert != "" && RegistryTokenSignerMatches(k, cert) {
			return k, true
		}
	}
	return "", false
}

func ensureRegistryTokenSigner() error {
	current := kubeSecretValue(RegistrySignerNamespace, "registry-token-signer", "key.pem")
	legacy := kubeSecretValue("builds", "registry-token-signer", "key.pem")
	cert := kubeSecretValue("registry", "registry-token-cert", "cert.pem")
	key, ok := chooseRegistrySigner(current, legacy, cert)
	if !ok {
		var err error
		if key, cert, err = GenerateRegistryTokenSigner(); err != nil {
			return err
		}
		// Certificate first: during rotation the registry must never trust a key the API no longer has.
		if err := applySecret("registry", "registry-token-cert", map[string]string{"cert.pem": cert}); err != nil {
			return err
		}
	}
	if key != current {
		// The API rewrites project pull Secrets when it sees the new key (source-pull-sync.ts).
		if err := applySecret(RegistrySignerNamespace, "registry-token-signer", map[string]string{"key.pem": key}); err != nil {
			return err
		}
	}
	return shell.RunBash("kubectl -n builds delete secret registry-token-signer --ignore-not-found >/dev/null")
}

func InstallBuilds(c *config.Config) error {
	if !BuildsEnabled(c) {
		return nil
	}
	builds, err := BuildNamespaceManifest(c)
	if err != nil {
		return err
	}
	if !bucketName.MatchString(registryBucket(c)) {
		return fmt.Errorf("invalid BUILDS_S3_BUCKET")
	}
	for _, ns := range []string{"registry", "builds"} {
		if _, err := shell.RunWithInput("kubectl", []string{"apply", "-f", "-"}, fmt.Sprintf(`{"apiVersion":"v1","kind":"Namespace","metadata":{"name":%q}}`, ns)); err != nil {
			return err
		}
	}
	httpSecret := kubeSecretValue("registry", "registry-auth", "http-secret")
	if httpSecret == "" {
		b := make([]byte, 32)
		if _, err := rand.Read(b); err != nil {
			return err
		}
		httpSecret = hex.EncodeToString(b)
	}
	// Only the upload-state secret remains: the shared htpasswd login is gone.
	if err := applySecret("registry", "registry-auth", map[string]string{"http-secret": httpSecret}); err != nil {
		return err
	}
	if err := ensureRegistryTokenSigner(); err != nil {
		return err
	}
	// Retire the previous design's shared push credential and public registry endpoint.
	if err := shell.RunBash("kubectl -n builds delete secret build-registry-auth --ignore-not-found && kubectl -n registry delete ingress registry --ignore-not-found"); err != nil {
		return err
	}
	if c.BuildsS3Endpoint == "" {
		// Reuse the bundled MinIO's existing mc binary. The registry gets a bucket-scoped user.
		if err := shell.RunBashEnv(registryStorageScript, map[string]string{"ROOT_ACCESS": c.MinioAccessKey, "ROOT_SECRET": c.MinioSecretKey, "BUCKET": registryBucket(c)}); err != nil {
			return err
		}
	} else if kubeSecretValue("registry", "registry-storage", "REGISTRY_STORAGE_S3_ACCESSKEY") == "" {
		return fmt.Errorf("external S3 requires Secret registry/registry-storage")
	}
	realm, err := RegistryTokenRealm(clusterIP("platform", "platform-api"))
	if err != nil {
		return err
	}
	registry, err := BuildRegistryManifest(c, realm)
	if err != nil {
		return err
	}
	for _, manifest := range []string{registry, builds} {
		if _, err := shell.RunWithInput("kubectl", []string{"apply", "-f", "-"}, manifest); err != nil {
			return err
		}
	}
	// Clone and base-image pulls trust the same CA as the existing ingress setup.
	bundle, err := os.ReadFile("/etc/ssl/certs/ca-certificates.crt")
	if err != nil {
		return fmt.Errorf("read system CA bundle: %w", err)
	}
	if ca := kubeSecretValue("cert-manager", "platform-ca", "ca.crt"); ca != "" {
		bundle = append(bundle, []byte("\n"+ca)...)
	}
	cm, _ := json.Marshal(map[string]any{"apiVersion": "v1", "kind": "ConfigMap", "metadata": map[string]string{"name": "build-ca", "namespace": "builds"}, "data": map[string]string{"ca.crt": string(bundle)}})
	if _, err := shell.RunWithInput("kubectl", []string{"apply", "-f", "-"}, string(cm)); err != nil {
		return err
	}
	if err := installBuildRuntime(); err != nil {
		return err
	}
	ip, err := netip.ParseAddr(clusterIP("registry", "registry"))
	if err != nil {
		return fmt.Errorf("registry ClusterIP unavailable")
	}
	changed, err := k3s.WriteBuildRegistry(c.GitHubToken, "registry."+c.Domain, "http://"+net.JoinHostPort(ip.String(), "5000"))
	if err != nil {
		return err
	}
	if changed {
		if err := shell.RunBash("systemctl restart k3s"); err != nil {
			return err
		}
	}
	if err := shell.RunBash("kubectl -n registry rollout status deployment/registry --timeout=180s"); err != nil {
		return err
	}
	return state.MarkDone("builds")
}

const registryStorageScript = `set -euo pipefail
set +x
umask 077
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
access=cairn-registry
secret="$(kubectl -n registry get secret registry-storage -o jsonpath='{.data.REGISTRY_STORAGE_S3_SECRETKEY}' 2>/dev/null | base64 -d || true)"
[[ -n "$secret" ]] || secret="$(openssl rand -hex 32)"
[[ "$BUCKET" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || { echo "invalid bucket" >&2; exit 1; }
pod="$(kubectl -n storage get pods -l app.kubernetes.io/instance=minio,app.kubernetes.io/component=minio -o jsonpath='{.items[0].metadata.name}')"
{
 printf 'ROOT_ACCESS=%q\nROOT_SECRET=%q\nACCESS=%q\nSECRET=%q\nBUCKET=%q\n' "$ROOT_ACCESS" "$ROOT_SECRET" "$access" "$secret" "$BUCKET"
 cat <<'SETUP'
set -euo pipefail
set +x
umask 077
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
export MC_CONFIG_DIR="$work/mc"
mc alias set bundled http://127.0.0.1:9000 "$ROOT_ACCESS" "$ROOT_SECRET" >/dev/null 2>&1
mc mb --ignore-existing "bundled/$BUCKET" >/dev/null 2>&1
printf '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:ListBucket","s3:GetBucketLocation","s3:ListBucketMultipartUploads"],"Resource":["arn:aws:s3:::%s"]},{"Effect":"Allow","Action":["s3:GetObject","s3:PutObject","s3:DeleteObject","s3:AbortMultipartUpload","s3:ListMultipartUploadParts"],"Resource":["arn:aws:s3:::%s/*"]}]}' "$BUCKET" "$BUCKET" > "$work/policy.json"
mc admin policy create bundled cairn-registry "$work/policy.json" >/dev/null 2>&1
mc admin user add bundled "$ACCESS" "$SECRET" >/dev/null 2>&1
mc admin policy attach bundled cairn-registry --user "$ACCESS" >/dev/null 2>&1 || mc admin user info bundled "$ACCESS" | grep -q cairn-registry
SETUP
} | kubectl -n storage exec -i "$pod" -- /bin/bash -s
printf '%s' "$access" > "$work/access"
printf '%s' "$secret" > "$work/secret"
kubectl -n registry create secret generic registry-storage --from-file=REGISTRY_STORAGE_S3_ACCESSKEY="$work/access" --from-file=REGISTRY_STORAGE_S3_SECRETKEY="$work/secret" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
`
