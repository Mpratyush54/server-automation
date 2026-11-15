package components

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
)

const testRealm = "http://10.43.0.20:3000/api/registry/token"

func TestBuildsProfileGate(t *testing.T) {
	for _, profile := range config.Profiles {
		for _, enabled := range []bool{false, true} {
			c := &config.Config{Profile: profile, BuildsEnabled: enabled, Domain: "example.com", BuildsEgressCIDRs: "192.0.2.0/24"}
			registry, err := BuildRegistryManifest(c, testRealm)
			if err != nil {
				t.Fatal(err)
			}
			want := enabled && profile != config.ProfileMinimal
			if (registry != "") != want {
				t.Fatalf("%s enabled=%v", profile, enabled)
			}
		}
	}
}

func TestRegistryUsesScopedTokenAuthAndIsNotPublic(t *testing.T) {
	c := &config.Config{Profile: config.ProfileStandard, BuildsEnabled: true, Domain: "example.com", MinioSecretKey: "must-not-render", BuildsS3Bucket: "platform-registry"}
	manifest, err := BuildRegistryManifest(c, testRealm)
	if err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{BuildRegistryImage, "platform-registry", "http://minio.storage.svc:9000", "registry-storage", "token:",
		`realm: "` + testRealm + `"`, "service: cairn-registry", "issuer: cairn-api", "rootcertbundle: /token/cert.pem", "secretName: registry-token-cert",
		"requests:", "limits:", "runAsNonRoot: true", "redirect: {disable: true}", "kubernetes.io/metadata.name: builds", "app: platform-api"} {
		if !strings.Contains(manifest, required) {
			t.Errorf("missing %s", required)
		}
	}
	for _, forbidden := range []string{"htpasswd", "kind: Ingress", "registry-tls", c.MinioSecretKey, "0.0.0.0/0"} {
		if strings.Contains(manifest, forbidden) {
			t.Errorf("registry manifest must not contain %q", forbidden)
		}
	}
	c.BuildsRegistryNodeCIDRs = "203.0.113.10/32,203.0.113.11/32"
	manifest, _ = BuildRegistryManifest(c, testRealm)
	if !strings.Contains(manifest, "ipBlock: {cidr: 203.0.113.10/32}") || !strings.Contains(manifest, "ipBlock: {cidr: 203.0.113.11/32}") {
		t.Fatal("node pull addresses not rendered")
	}
	c.BuildsRegistryNodeCIDRs = "not-a-cidr"
	if _, err := BuildRegistryManifest(c, testRealm); err == nil {
		t.Fatal("invalid node CIDR accepted")
	}
	c.BuildsRegistryNodeCIDRs = ""
	for _, realm := range []string{"", "https://10.43.0.20:3000/api/registry/token", "http://api.example.com:3000/api/registry/token", "http://10.43.0.20:3000/other"} {
		if _, err := BuildRegistryManifest(c, realm); err == nil {
			t.Errorf("accepted realm %q", realm)
		}
	}
	c.BuildsS3Endpoint = "https://s3.example.com"
	c.BuildsS3Bucket = "images"
	manifest, err = BuildRegistryManifest(c, testRealm)
	if err != nil || !strings.Contains(manifest, c.BuildsS3Endpoint) || strings.Contains(manifest, "platform-registry") || !strings.Contains(manifest, `bucket: "images"`) {
		t.Fatal("external S3 not rendered")
	}
	c.BuildsS3Bucket = "Bad_Bucket"
	if _, err := BuildRegistryManifest(c, testRealm); err == nil {
		t.Fatal("invalid bucket accepted")
	}
	c.BuildsS3Bucket = "images"
	c.Domain = "example.com\ninvalid"
	if _, err := BuildRegistryManifest(c, testRealm); err == nil {
		t.Fatal("invalid domain accepted")
	}
}

func TestBundledMinIOUsesConfiguredBucket(t *testing.T) {
	if strings.Contains(registryStorageScript, "bundled/platform-registry") || strings.Contains(registryStorageScript, "arn:aws:s3:::platform-registry") {
		t.Fatal("bundled MinIO setup ignores BUILDS_S3_BUCKET")
	}
	for _, want := range []string{`"bundled/$BUCKET"`, `"$BUCKET" "$BUCKET"`, "BUCKET=%q"} {
		if !strings.Contains(registryStorageScript, want) {
			t.Errorf("missing %s", want)
		}
	}
}

func TestRegistryTokenRealmUsesAPIClusterIP(t *testing.T) {
	if realm, err := RegistryTokenRealm("10.43.0.20"); err != nil || realm != testRealm {
		t.Fatalf("realm %q %v", realm, err)
	}
	if realm, _ := RegistryTokenRealm("fd00::20"); realm != "http://[fd00::20]:3000/api/registry/token" {
		t.Fatalf("ipv6 realm %q", realm)
	}
	if _, err := RegistryTokenRealm(""); err == nil {
		t.Fatal("empty ClusterIP accepted")
	}
}

func TestBuildNamespaceIsolation(t *testing.T) {
	c := &config.Config{Profile: config.ProfileFull, BuildsEnabled: true, BuildsEgressCIDRs: "192.0.2.0/24,198.51.100.2/32"}
	manifest, err := BuildNamespaceManifest(c)
	if err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{"pod-security.kubernetes.io/enforce: baseline", "ingress: []", "policyTypes: [Ingress, Egress]", "ipBlock: {cidr: 192.0.2.0/24}",
		"ipBlock: {cidr: 198.51.100.2/32}", "kube-dns", "port: 443", "kubernetes.io/metadata.name: registry", "port: 5000", "kind: ResourceQuota",
		"requests.ephemeral-storage: 16Gi", "limits.ephemeral-storage: 100Gi", "namespace: platform", "resources: [jobs]", "resources: [pods, pods/log]"} {
		if !strings.Contains(manifest, required) {
			t.Errorf("missing %s", required)
		}
	}
	if strings.Contains(manifest, "port: 80,") || strings.Contains(manifest, "privileged") {
		t.Fatal("builds egress must stay HTTPS-only and unprivileged")
	}
	for _, invalid := range []string{"", "0.0.0.0/0", "::/0", "2001:db8::/32", "github.com", "10.0.0.0/8", "10.42.1.0/24", "169.254.169.254/32", "172.16.5.0/24", "192.0.2.1/24"} {
		c.BuildsEgressCIDRs = invalid
		if _, err := BuildNamespaceManifest(c); err == nil {
			t.Errorf("accepted %q", invalid)
		}
	}
}

func TestBuildEgressAlwaysExcludesPrivateAndClusterRanges(t *testing.T) {
	peers, err := BuildEgressPeers("8.0.0.0/5,128.0.0.0/1")
	if err != nil {
		t.Fatal(err)
	}
	// 8.0.0.0/5 covers 8.0.0.0-15.255.255.255, so 10/8 and the pod/service CIDRs inside it must be excepted.
	if !strings.Contains(peers, "cidr: 8.0.0.0/5, except: [10.0.0.0/8, 10.42.0.0/16, 10.43.0.0/16]") {
		t.Fatalf("10/8 and cluster CIDRs not excluded:\n%s", peers)
	}
	for _, want := range []string{"172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "224.0.0.0/4", "240.0.0.0/4"} {
		if !strings.Contains(peers, want) {
			t.Errorf("128.0.0.0/1 must except %s:\n%s", want, peers)
		}
	}
}

// Build egress must exclude at least everything project egress excludes.
func TestBuildBlockedNetworksCoverNamespaceBaseline(t *testing.T) {
	source, err := os.ReadFile(filepath.Join("..", "..", "..", "platform", "api", "src", "lib", "namespace-baseline.ts"))
	if err != nil {
		t.Skip("API sources not present")
	}
	line := ""
	for _, l := range strings.Split(string(source), "\n") {
		if strings.Contains(l, "export const privateNetworks") {
			line = l
		}
	}
	if line == "" {
		t.Fatal("privateNetworks not found in namespace-baseline.ts")
	}
	blocked := strings.Join(buildBlockedNetworks, " ")
	for _, part := range strings.Split(line[strings.Index(line, "[")+1:strings.Index(line, "]")], ",") {
		cidr := strings.Trim(strings.TrimSpace(part), "'")
		if !strings.Contains(" "+blocked+" ", " "+cidr+" ") {
			t.Errorf("build egress does not exclude %s", cidr)
		}
	}
	for _, cluster := range []string{"10.42.0.0/16", "10.43.0.0/16", "169.254.0.0/16"} {
		if !strings.Contains(blocked, cluster) {
			t.Errorf("build egress does not exclude %s", cluster)
		}
	}
}

func TestRegistryTokenSigner(t *testing.T) {
	key, cert, err := GenerateRegistryTokenSigner()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(key, "BEGIN PRIVATE KEY") || !strings.Contains(cert, "BEGIN CERTIFICATE") || !RegistryTokenSignerMatches(key, cert) {
		t.Fatal("signer key and certificate do not match")
	}
	other, _, _ := GenerateRegistryTokenSigner()
	if RegistryTokenSignerMatches(other, cert) || RegistryTokenSignerMatches("", cert) {
		t.Fatal("mismatched signer accepted")
	}
}

func TestRegistrySignerIsKeptOrMovedNotRotated(t *testing.T) {
	key, cert, _ := GenerateRegistryTokenSigner()
	other, _, _ := GenerateRegistryTokenSigner()
	if got, ok := chooseRegistrySigner(key, "", cert); !ok || got != key {
		t.Fatal("current signer not kept")
	}
	if got, ok := chooseRegistrySigner("", key, cert); !ok || got != key {
		t.Fatal("signer from the builds namespace not carried over")
	}
	if got, ok := chooseRegistrySigner(other, key, cert); !ok || got != key {
		t.Fatal("matching signer not preferred")
	}
	if _, ok := chooseRegistrySigner(other, "", cert); ok {
		t.Fatal("mismatched signer kept")
	}
	if _, ok := chooseRegistrySigner(key, key, ""); ok {
		t.Fatal("signer kept without a registry certificate")
	}
	if RegistrySignerNamespace != "platform" {
		t.Fatal("registry signer must live in the platform namespace")
	}
}

func TestBuildSecretsAreLimitedToPerBuildNames(t *testing.T) {
	c := &config.Config{Profile: config.ProfileFull, BuildsEnabled: true, BuildsEgressCIDRs: "192.0.2.0/24"}
	manifest, err := BuildNamespaceManifest(c)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"kind: ValidatingAdmissionPolicy", "name: platform-build-secrets", "failurePolicy: Fail", "operations: [CREATE, UPDATE, DELETE]",
		"matchLabels: {kubernetes.io/metadata.name: builds}", `^build-[0-9a-f-]{36}-(git|push)$`, "validationActions: [Deny]", "resourceNames: [build-ca]"} {
		if !strings.Contains(manifest, want) {
			t.Errorf("missing %s", want)
		}
	}
	if strings.Contains(manifest, "registry-token-signer") {
		t.Fatal("the signing key must not be managed in the builds namespace")
	}
}

func TestBuildkitRuntimeProfilesAreNarrow(t *testing.T) {
	var profile struct {
		DefaultAction string `json:"defaultAction"`
		Syscalls      []struct {
			Names  []string `json:"names"`
			Action string   `json:"action"`
			Args   []struct {
				Index uint   `json:"index"`
				Value uint64 `json:"value"`
				Op    string `json:"op"`
			} `json:"args"`
		} `json:"syscalls"`
	}
	if err := json.Unmarshal([]byte(BuildkitSeccompProfile()), &profile); err != nil {
		t.Fatal(err)
	}
	denied := map[string]bool{}
	netfilter := false
	for _, rule := range profile.Syscalls {
		if rule.Action != "SCMP_ACT_ERRNO" {
			t.Fatalf("unexpected action %s", rule.Action)
		}
		if len(rule.Args) > 0 {
			if len(rule.Names) != 1 || rule.Names[0] != "socket" || len(rule.Args) != 2 ||
				rule.Args[0].Index != 0 || rule.Args[0].Value != 16 || rule.Args[0].Op != "SCMP_CMP_EQ" ||
				rule.Args[1].Index != 2 || rule.Args[1].Value != 12 || rule.Args[1].Op != "SCMP_CMP_EQ" {
				t.Fatalf("unexpected conditional rule %+v", rule)
			}
			netfilter = true
			continue
		}
		for _, n := range rule.Names {
			denied[n] = true
		}
	}
	if !netfilter {
		t.Error("seccomp profile must refuse netfilter netlink sockets")
	}
	for _, must := range []string{"bpf", "ptrace", "kexec_load", "init_module", "finit_module", "keyctl", "add_key", "perf_event_open", "io_uring_setup", "open_by_handle_at", "userfaultfd"} {
		if !denied[must] {
			t.Errorf("seccomp profile must deny %s", must)
		}
	}
	for _, needed := range []string{"unshare", "clone", "mount", "pivot_root", "setns", "socket"} {
		if denied[needed] {
			t.Errorf("rootless BuildKit needs %s", needed)
		}
	}
	apparmor := BuildkitAppArmorProfile()
	for _, want := range []string{"profile " + BuildkitAppArmorProfileName, "userns,", "deny /sys/firmware/** rwklx", "deny @{PROC}/sysrq-trigger rwklx"} {
		if !strings.Contains(apparmor, want) {
			t.Errorf("AppArmor profile missing %s", want)
		}
	}
}

// The API renders the build Job; its profile names and node label must match what is installed.
func TestBuildRuntimeNamesMatchAPI(t *testing.T) {
	spec, err := os.ReadFile(filepath.Join("..", "..", "..", "platform", "api", "src", "lib", "build-spec.ts"))
	if err != nil {
		t.Skip("API sources not present")
	}
	seccompRel := strings.TrimPrefix(BuildkitSeccompProfilePath, "/var/lib/kubelet/seccomp/")
	for _, want := range []string{"'" + seccompRel + "'", "'" + BuildkitAppArmorProfileName + "'", "'" + BuildRuntimeLabel + "'", "'" + BuildRuntimeVersion + "'"} {
		if !strings.Contains(string(spec), want) {
			t.Errorf("build-spec.ts does not reference %s", want)
		}
	}
	token, err := os.ReadFile(filepath.Join("..", "..", "..", "platform", "api", "src", "lib", "registry-token.ts"))
	if err != nil {
		t.Skip("API sources not present")
	}
	for _, want := range []string{"'" + RegistryTokenService + "'", "'" + RegistryTokenIssuer + "'", "'registry.registry.svc.cluster.local:5000'", "'registry-token-signer'"} {
		if !strings.Contains(string(token), want) {
			t.Errorf("registry-token.ts does not reference %s", want)
		}
	}
}

func TestRegistryGCIsBoundedAndPreservesCacheManifests(t *testing.T) {
	manifest := RegistryGCManifest()
	for _, required := range []string{BuildRegistryImage, "garbage-collect", "activeDeadlineSeconds: 600", "registry-storage", "registry-token-cert", "automountServiceAccountToken: false"} {
		if !strings.Contains(manifest, required) {
			t.Errorf("missing %s", required)
		}
	}
	if strings.Contains(manifest, "delete-untagged") {
		t.Fatal("cache manifests must remain referenced")
	}
}
