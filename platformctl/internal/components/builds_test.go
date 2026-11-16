package components

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
)

const testRealm = RegistryTokenRealm

func TestBuildsProfileGate(t *testing.T) {
	for _, profile := range config.Profiles {
		for _, enabled := range []bool{false, true} {
			c := &config.Config{Profile: profile, BuildsEnabled: enabled, Domain: "example.com", BuildsEgressCIDRs: "192.0.2.0/24"}
			registry, err := BuildRegistryManifest(c, testRealm, DefaultBuildNetworks())
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
	manifest, err := BuildRegistryManifest(c, testRealm, DefaultBuildNetworks())
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
	manifest, _ = BuildRegistryManifest(c, testRealm, DefaultBuildNetworks())
	if !strings.Contains(manifest, "ipBlock: {cidr: 203.0.113.10/32}") || !strings.Contains(manifest, "ipBlock: {cidr: 203.0.113.11/32}") {
		t.Fatal("node pull addresses not rendered")
	}
	c.BuildsRegistryNodeCIDRs = "not-a-cidr"
	if _, err := BuildRegistryManifest(c, testRealm, DefaultBuildNetworks()); err == nil {
		t.Fatal("invalid node CIDR accepted")
	}
	c.BuildsRegistryNodeCIDRs = ""
	for _, realm := range []string{"", "http://10.43.0.20:3000/api/registry/token", "https://10.43.0.20:3000/api/registry/token", "http://api.example.com:3000/api/registry/token", "http://10.43.0.20:3000/other"} {
		if _, err := BuildRegistryManifest(c, realm, DefaultBuildNetworks()); err == nil {
			t.Errorf("accepted realm %q", realm)
		}
	}
	c.BuildsS3Endpoint = "https://s3.example.com"
	c.BuildsS3Bucket = "images"
	manifest, err = BuildRegistryManifest(c, testRealm, DefaultBuildNetworks())
	if err != nil || !strings.Contains(manifest, c.BuildsS3Endpoint) || strings.Contains(manifest, "platform-registry") || !strings.Contains(manifest, `bucket: "images"`) {
		t.Fatal("external S3 not rendered")
	}
	c.BuildsS3Bucket = "Bad_Bucket"
	if _, err := BuildRegistryManifest(c, testRealm, DefaultBuildNetworks()); err == nil {
		t.Fatal("invalid bucket accepted")
	}
	c.BuildsS3Bucket = "images"
	c.Domain = "example.com\ninvalid"
	if _, err := BuildRegistryManifest(c, testRealm, DefaultBuildNetworks()); err == nil {
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

func TestRegistryTokenRealmIsAHostName(t *testing.T) {
	// Registry clients (crane, the Buildpacks lifecycle) refuse realms on private IP literals.
	u, err := url.Parse(RegistryTokenRealm)
	if err != nil || u.Scheme != "http" || u.Port() != "3000" || u.Path != "/api/registry/token" || u.Hostname() != RegistryTokenHost {
		t.Fatalf("realm %q", RegistryTokenRealm)
	}
	if _, err := netip.ParseAddr(u.Hostname()); err == nil || !strings.HasSuffix(RegistryTokenHost, ".internal") {
		t.Fatalf("realm host must be a reserved name, not an address: %q", RegistryTokenHost)
	}
}

func TestBuildNamespaceIsolation(t *testing.T) {
	c := &config.Config{Profile: config.ProfileFull, BuildsEnabled: true, BuildsEgressCIDRs: "192.0.2.0/24,198.51.100.2/32"}
	manifest, err := BuildNamespaceManifest(c, DefaultBuildNetworks())
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
		if _, err := BuildNamespaceManifest(c, DefaultBuildNetworks()); err == nil {
			t.Errorf("accepted %q", invalid)
		}
	}
}

func TestBuildEgressAlwaysExcludesPrivateAndClusterRanges(t *testing.T) {
	peers, err := BuildEgressPeers("8.0.0.0/5,128.0.0.0/1", DefaultBuildNetworks())
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
	var all []string
	for _, b := range DefaultBuildNetworks().blocked() {
		all = append(all, b.String())
	}
	blocked := strings.Join(all, " ")
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

func TestBuildEgressUsesConfiguredClusterAndNodeNetworks(t *testing.T) {
	n := BuildNetworks{
		Cluster: []netip.Prefix{netip.MustParsePrefix("10.52.0.0/16"), netip.MustParsePrefix("10.53.0.0/16"), netip.MustParsePrefix("fd00:42::/56")},
		Nodes:   []netip.Prefix{netip.MustParsePrefix("203.0.113.7/32")},
	}
	peers, err := BuildEgressPeers("8.0.0.0/5,203.0.113.0/24", n)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(peers, "cidr: 8.0.0.0/5, except: [10.0.0.0/8, 10.52.0.0/16, 10.53.0.0/16]") || strings.Contains(peers, "10.42.0.0/16") {
		t.Fatalf("configured cluster CIDRs not used:\n%s", peers)
	}
	if !strings.Contains(peers, "cidr: 203.0.113.0/24, except: [203.0.113.7/32]") {
		t.Fatalf("node address not excluded:\n%s", peers)
	}
	if _, err := BuildEgressPeers("203.0.113.7/32", n); err == nil {
		t.Fatal("egress to a node address accepted")
	}
	// Operator-listed node addresses are excluded too.
	c := &config.Config{Profile: config.ProfileFull, BuildsEnabled: true, BuildsEgressCIDRs: "198.51.100.0/24", BuildsRegistryNodeCIDRs: "198.51.100.9/32"}
	manifest, err := BuildNamespaceManifest(c, DefaultBuildNetworks())
	if err != nil || !strings.Contains(manifest, "cidr: 198.51.100.0/24, except: [198.51.100.9/32]") {
		t.Fatalf("operator node address not excluded (%v):\n%s", err, manifest)
	}
}

func TestRegistryNodeCIDRsAreNodeSized(t *testing.T) {
	c := &config.Config{Profile: config.ProfileStandard, BuildsEnabled: true, Domain: "example.com"}
	for _, bad := range []string{"0.0.0.0/0", "10.0.0.0/8", "203.0.0.0/15", "10.42.0.0/24", "10.0.0.0/12", "::/0", "fd00::/48"} {
		c.BuildsRegistryNodeCIDRs = bad
		if _, err := BuildRegistryManifest(c, testRealm, DefaultBuildNetworks()); err == nil {
			t.Errorf("accepted node CIDR %q", bad)
		}
	}
	for _, good := range []string{"192.168.0.0/16", "203.0.113.10/32", "10.0.1.0/24"} {
		c.BuildsRegistryNodeCIDRs = good
		if _, err := BuildRegistryManifest(c, testRealm, DefaultBuildNetworks()); err != nil {
			t.Errorf("rejected node CIDR %q: %v", good, err)
		}
	}
	c.BuildsRegistryNodeCIDRs = "10.42.0.0/24"
	custom := BuildNetworks{Cluster: []netip.Prefix{netip.MustParsePrefix("10.60.0.0/16")}}
	if _, err := BuildRegistryManifest(c, testRealm, custom); err != nil {
		t.Errorf("node CIDR outside the configured cluster network rejected: %v", err)
	}
}

func TestNodeAddressPrefixes(t *testing.T) {
	got := nodeAddressPrefixes("InternalIP 10.0.0.5\nExternalIP 203.0.113.7\nHostname node-a\nInternalIP 10.0.0.5\nExternalIP fd00::7\nInternalIP bad\n")
	want := []string{"10.0.0.5/32", "203.0.113.7/32", "fd00::7/128"}
	if len(got) != len(want) {
		t.Fatalf("got %v", got)
	}
	for i := range want {
		if got[i].String() != want[i] {
			t.Fatalf("got %v", got)
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
	manifest, err := BuildNamespaceManifest(c, DefaultBuildNetworks())
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
			Errno  uint     `json:"errnoRet"`
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
	errnos := map[string]uint{}
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
			errnos[n] = rule.Errno
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
	for _, name := range []string{"fsopen", "fsconfig", "fsmount", "fspick", "move_mount", "open_tree", "mount_setattr"} {
		if !denied[name] || errnos[name] != 38 {
			t.Errorf("%s must return ENOSYS, got %d", name, errnos[name])
		}
	}
	apparmor := BuildkitAppArmorProfile()
	for _, want := range []string{"profile " + BuildkitAppArmorProfileName, "userns,", "mqueue,", "deny /sys/firmware/** rwklx", "deny @{PROC}/sysrq-trigger rwklx"} {
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

func TestBuildsEnvPatchPublishesAvailabilityOnExistingInstall(t *testing.T) {
	c := &config.Config{Profile: config.ProfileStandard, BuildsEnabled: true, Domain: "example.test"}
	current := map[string]string{"BUILDS_ENABLED": "false", "BUILDS_REGISTRY": "registry.example.test"}
	patch, ok := buildsEnvPatch(c, func(k string) string { return current[k] })
	if !ok || !strings.Contains(patch, `"BUILDS_ENABLED":"true"`) || !strings.Contains(patch, `"BUILDS_REGISTRY":"registry.example.test"`) {
		t.Fatalf("expected a patch enabling builds, got ok=%v %s", ok, patch)
	}
	current["BUILDS_ENABLED"] = "true"
	if _, ok := buildsEnvPatch(c, func(k string) string { return current[k] }); ok {
		t.Fatal("no patch (and no API restart) expected when platform-env already matches")
	}
	if got := platformEnvValues(c); got["BUILDS_ENABLED"] != "true" || got["BUILDS_REGISTRY"] != "registry.example.test" {
		t.Fatalf("platform-env must carry the same build settings: %v", got)
	}
}

func TestRegistryRestartsWhenTheTokenCertificateChanges(t *testing.T) {
	a, b := registryCertPatch("cert-a"), registryCertPatch("cert-b")
	if a == b || a != registryCertPatch("cert-a") {
		t.Fatalf("patch must change with the certificate and only then: %s %s", a, b)
	}
	if !strings.Contains(a, `"cairn.dev/token-cert"`) || !strings.Contains(a, `"template"`) {
		t.Fatalf("patch must annotate the pod template: %s", a)
	}
}

type buildMetadataClient func(*http.Request) (*http.Response, error)

func (f buildMetadataClient) Do(r *http.Request) (*http.Response, error) { return f(r) }

func TestBuildPublicAddresses(t *testing.T) {
	for _, tc := range []struct {
		name, token, address string
		status               int
		unreachable          bool
		want                 []string
	}{
		{"success", "test-token", "203.0.113.9", 200, false, []string{"203.0.113.9/32"}},
		{"invalid", "test-token", "invalid", 200, false, nil},
		{"ipv6", "test-token", "2001:db8::1", 200, false, nil},
		{"empty token", "", "", 200, false, nil},
		{"http error", "", "", 403, false, nil},
		{"unreachable", "", "", 0, true, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			client := buildMetadataClient(func(r *http.Request) (*http.Response, error) {
				calls++
				deadline, ok := r.Context().Deadline()
				if !ok || time.Until(deadline) > time.Second {
					t.Fatal("metadata must have a one-second deadline")
				}
				if r.URL.Host != "169.254.169.254" {
					t.Fatalf("unexpected metadata host %s", r.URL.Host)
				}
				if tc.unreachable {
					return nil, errors.New("unreachable")
				}
				body := tc.token
				if calls == 1 {
					if r.Method != "PUT" || r.URL.Path != "/latest/api/token" || r.Header.Get("X-aws-ec2-metadata-token-ttl-seconds") != "60" {
						t.Fatal("missing IMDSv2 token request")
					}
				} else {
					if calls != 2 || r.Method != "GET" || r.URL.Path != "/latest/meta-data/public-ipv4" || r.Header.Get("X-aws-ec2-metadata-token") != tc.token {
						t.Fatal("missing IMDSv2 address request")
					}
					body = tc.address
				}
				return &http.Response{StatusCode: tc.status, Body: io.NopCloser(strings.NewReader(body))}, nil
			})
			got := buildPublicAddresses(client)
			var gotS []string
			for _, p := range got {
				gotS = append(gotS, p.String())
			}
			if !slices.Equal(gotS, tc.want) {
				t.Fatalf("got %v, want %v", gotS, tc.want)
			}
		})
	}
}

func TestBuildMetadataAddressFailureIsOptional(t *testing.T) {
	for _, fail := range []string{"status", "network", "deadline"} {
		t.Run(fail, func(t *testing.T) {
			calls := 0
			got := buildPublicAddresses(buildMetadataClient(func(r *http.Request) (*http.Response, error) {
				calls++
				if calls == 1 {
					return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader("token"))}, nil
				}
				switch fail {
				case "status":
					return &http.Response{StatusCode: 404, Body: io.NopCloser(strings.NewReader("unavailable"))}, nil
				case "deadline":
					<-r.Context().Done()
					return nil, r.Context().Err()
				default:
					return nil, errors.New("unreachable")
				}
			}))
			if len(got) != 0 || calls != 2 {
				t.Fatalf("metadata failure must yield no addresses: %v (%d requests)", got, calls)
			}
		})
	}
}

func TestBuildPublicAndExtraNetworksExcluded(t *testing.T) {
	c := &config.Config{Profile: config.ProfileStandard, BuildsEnabled: true, BuildsEgressCIDRs: "203.0.113.0/24", BuildsExtraBlockedCIDRs: "203.0.113.8/32,203.0.113.16/28,203.0.113.8/32"}
	n := DefaultBuildNetworks()
	n.Nodes = []netip.Prefix{netip.MustParsePrefix("203.0.113.7/32")}
	n.Public = []netip.Prefix{netip.MustParsePrefix("203.0.113.7/32"), netip.MustParsePrefix("203.0.113.8/32")}
	manifest, err := BuildNamespaceManifest(c, n)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(manifest, "except: [203.0.113.7/32, 203.0.113.8/32, 203.0.113.16/28]") {
		t.Fatalf("missing deduplicated public exclusions: %s", manifest)
	}
	again, err := BuildNamespaceManifest(c, n)
	if err != nil || again != manifest {
		t.Fatal("manifest must be idempotent")
	}
	for _, bad := range []string{"bad", "0.0.0.0/0", "::/0", "203.0.113.1/24"} {
		c.BuildsExtraBlockedCIDRs = bad
		if _, err := BuildNamespaceManifest(c, n); err == nil {
			t.Errorf("accepted extra CIDR %s", bad)
		}
	}
	c.BuildsExtraBlockedCIDRs = "203.0.113.0/24"
	if _, err := BuildNamespaceManifest(c, n); err == nil {
		t.Fatal("egress wholly inside extra block must fail")
	}
}
