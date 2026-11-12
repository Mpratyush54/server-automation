package config

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/fatih/color"
	"golang.org/x/term"
)

// DefaultImageTag is set at link time by GoReleaser (e.g. "1.2.3").
// Falls back to "latest" for local/dev builds.
var DefaultImageTag = "latest"

type Config struct {
	Domain        string
	AdminEmail    string
	AdminPassword string
	PlatformName  string

	NonInteractive bool
	SkipK8s        bool
	SkipPreflight  bool
	ResetPortainer bool
	SkipHardening  bool
	WAF            bool
	NginxAuthJail  bool

	// Ingress per-client-IP limits. Zero disables the corresponding limit.
	IngressIPRateLimit   int
	IngressIPBurst       int
	IngressIPConnections int

	ImageRegistry string
	ImageTag      string
	RepoURL       string
	GitHubToken   string

	InstallArgoCD      bool
	InstallMonitoring  bool
	InstallPortainer   bool
	InstallCertManager bool
	AutoUpdate         bool
	AutoUpgrade        bool // Opt-in daily release patch upgrades.

	// InstallKyverno enables the Kyverno admission controller. Only honored
	// when Profile is full and INSTALL_KYVERNO=true (opt-in; keeps default
	// installs light). See docs/operations/image-signing.md.
	InstallKyverno bool
	// InstallKyvernoCVEPolicy applies the optional CVE ClusterPolicy that
	// consumes Trivy Operator VulnerabilityReports. Trivy Operator itself is
	// never installed by platformctl.
	InstallKyvernoCVEPolicy bool
	// KyvernoPolicyMode is Audit (default) or Enforce for Kyverno policies.
	KyvernoPolicyMode string
	// LonghornReplicas is 0 (auto) or an explicit count from 1 through 3.
	LonghornReplicas     int
	LonghornBackupTarget string
	// LonghornBackupSecret names an operator-created Secret; credentials stay out of .env.
	LonghornBackupSecret string
	// PostgreSQL HA (#51, ha profile only): storage class of the CloudNativePG
	// instances and the WAL/base-backup target. The Secret is operator-created
	// in namespace databases; credentials never go to .env.
	PostgresHAStorageClass    string
	PostgresBackupDestination string
	PostgresBackupEndpoint    string
	PostgresBackupSecret      string
	PostgresBackupRetention   string

	// SyntheticsBrowser enables browser synthetic checks (headless Chromium
	// CronJobs, #42). Only honored on the full profile with SYNTHETICS_BROWSER=true.
	SyntheticsBrowser bool

	// Profile is the install profile (minimal|standard|full) that set the
	// Install* defaults. See ApplyProfile.
	Profile                     string
	TelemetryRetentionDays      string
	TelemetryLokiDatasourceUID  string
	TelemetrySamplingPercentage string
	// explicitInstall holds INSTALL_* values set in the real process
	// environment (not loaded from /etc/platform/.env); they always win over
	// the profile.
	explicitInstall map[string]bool

	// APIReplicas is the platform-api Deployment replica count. Defaults from the
	// profile (minimal: 1, otherwise 2); API_REPLICAS overrides it.
	APIReplicas int
	// explicitAPIReplicas is API_REPLICAS from the real process environment (0 = unset).
	explicitAPIReplicas int

	PostgresPassword     string
	MongoPassword        string
	RedisPassword        string
	MinioAccessKey       string
	MinioSecretKey       string
	JWTSecret            string
	SecretsEncryptionKey string
	WebhookSecret        string
	ArgoCDPassword       string
	GrafanaPassword      string
	PortainerPassword    string
	LEEmail              string

	// Per-client secrets for the platform's built-in OIDC provider. The API
	// receives them via OIDC_CLIENTS; each SSO client gets its own.
	OIDCSecretGrafana     string
	OIDCSecretArgoCD      string
	OIDCSecretPortainer   string
	OIDCSecretOAuth2Proxy string
	OIDCSecretMinio       string

	// PasswordGenerated is set when admin password was auto-created this run.
	PasswordGenerated bool

	// Cluster is the multi-node configuration of the ha profile (#53).
	Cluster Cluster
	// Ingress HA (ha profile only). See docs/operations/ha.md and #54.
	// IngressHAMode is "vip" (kube-vip) or "external" (operator LB / DNS failover).
	IngressHAMode string
	// IngressVIP is the floating Service IP advertised by kube-vip (vip mode).
	IngressVIP string
	// IngressVIPInterface is the NIC for ARP; empty = default-route interface.
	IngressVIPInterface string
	// APIVIP is an optional floating Kubernetes API address (vip mode).
	APIVIP string
}

// Ingress HA modes (INGRESS_HA_MODE).
const (
	IngressHAModeVIP      = "vip"
	IngressHAModeExternal = "external"
)

func Load() *Config {
	tagDefault := DefaultImageTag
	if tagDefault == "" {
		tagDefault = "latest"
	}
	// Capture what the operator set explicitly before the saved .env is merged
	// into the environment, so profile resolution can tell them apart.
	explicit := explicitEnv()
	explicitReplicas := explicitAPIReplicasEnv()
	// Prefer values already written by a prior provision.
	_ = loadDotEnv(envFilePath)

	c := &Config{
		TelemetrySamplingPercentage: getEnv("TELEMETRY_SAMPLING_PERCENTAGE", "100"),
		TelemetryLokiDatasourceUID:  getEnv("TELEMETRY_LOKI_DATASOURCE_UID", "loki"),
		TelemetryRetentionDays:      getEnv("TELEMETRY_RETENTION_DAYS", "30"),
		PlatformName:                getEnv("PLATFORM_NAME", "Platform"),
		ImageRegistry:               getEnv("PLATFORM_IMAGE_REGISTRY", "ghcr.io/mpratyush54"),
		ImageTag:                    getEnv("PLATFORM_IMAGE_TAG", tagDefault),
		RepoURL:                     getEnv("PLATFORM_REPO_URL", "https://github.com/Mpratyush54/SERVER-automation"),
		GitHubToken:                 getEnv("GITHUB_TOKEN", ""),
		Domain:                      firstNonEmpty(os.Getenv("DOMAIN"), os.Getenv("PLATFORM_DOMAIN")),
		AdminEmail:                  os.Getenv("ADMIN_EMAIL"), // empty → prompt will ask
		AdminPassword:               getEnv("ADMIN_PASSWORD", ""),
		NonInteractive:              os.Getenv("NON_INTERACTIVE") == "true" || os.Getenv("PLATFORMCTL_AUTO") == "true",
		SkipK8s:                     os.Getenv("SKIP_K8S") == "true",
		SkipPreflight:               os.Getenv("SKIP_PREFLIGHT") == "true",
		AutoUpdate:                  getEnvBool("AUTO_UPDATE", true),
		AutoUpgrade:                 getEnvBool("AUTO_UPGRADE", false),
		SkipHardening:               !getEnvBool("PLATFORM_HARDEN", true) || getEnvBool("SKIP_HARDENING", false),
		WAF:                         getEnvBool("PLATFORM_WAF", false),
		NginxAuthJail:               getEnvBool("PLATFORM_NGINX_AUTH_JAIL", false),
		IngressIPRateLimit:          getEnvIngressLimit("INGRESS_IP_RATE_LIMIT", 1000, 1000000),
		IngressIPBurst:              getEnvIngressLimit("INGRESS_IP_BURST", 2000, 1000000),
		IngressIPConnections:        getEnvIngressLimit("INGRESS_IP_CONNECTIONS", 2000, 65535),
		MinioAccessKey:              getEnv("MINIO_ACCESS_KEY", "platformadmin"),
		PostgresPassword:            os.Getenv("POSTGRES_PASSWORD"),
		MongoPassword:               os.Getenv("MONGO_PASSWORD"),
		RedisPassword:               os.Getenv("REDIS_PASSWORD"),
		MinioSecretKey:              os.Getenv("MINIO_SECRET_KEY"),
		JWTSecret:                   os.Getenv("JWT_SECRET"),
		SecretsEncryptionKey:        os.Getenv("SECRETS_ENCRYPTION_KEY"),
		WebhookSecret:               os.Getenv("PLATFORM_WEBHOOK_SECRET"),
		ArgoCDPassword:              os.Getenv("ARGOCD_PASSWORD"),
		GrafanaPassword:             os.Getenv("GRAFANA_PASSWORD"),
		PortainerPassword:           firstNonEmpty(os.Getenv("PORTAINER_ADMIN_PASSWORD"), os.Getenv("PORTAINER_PASSWORD")),
		LEEmail:                     firstNonEmpty(os.Getenv("LE_EMAIL"), os.Getenv("ADMIN_EMAIL")),

		OIDCSecretGrafana:     os.Getenv("OIDC_SECRET_GRAFANA"),
		OIDCSecretArgoCD:      os.Getenv("OIDC_SECRET_ARGOCD"),
		OIDCSecretPortainer:   os.Getenv("OIDC_SECRET_PORTAINER"),
		OIDCSecretOAuth2Proxy: os.Getenv("OIDC_SECRET_OAUTH2_PROXY"),
		OIDCSecretMinio:       os.Getenv("OIDC_SECRET_MINIO"),

		IngressVIP:          strings.TrimSpace(os.Getenv("INGRESS_VIP")),
		IngressVIPInterface: strings.TrimSpace(os.Getenv("INGRESS_VIP_INTERFACE")),
		APIVIP:              strings.TrimSpace(os.Getenv("API_VIP")),
	}
	c.IngressHAMode = resolveIngressHAMode(os.Getenv("INGRESS_HA_MODE"), c.IngressVIP)
	c.resolveProfile(explicit)
	_, profileExplicit := explicit["PLATFORM_PROFILE"]
	c.resolveAPIReplicas(explicitReplicas, profileExplicit)
	c.resolveKyverno()
	c.loadCluster()
	c.LonghornReplicas, _ = strconv.Atoi(strings.TrimSpace(os.Getenv("LONGHORN_REPLICAS")))
	if c.LonghornReplicas < 1 || c.LonghornReplicas > 3 {
		c.LonghornReplicas = 0
	}
	c.PostgresHAStorageClass = getEnv("POSTGRES_HA_STORAGE_CLASS", "local-path")
	c.PostgresBackupDestination = getEnv("POSTGRES_BACKUP_DESTINATION", "")
	c.PostgresBackupEndpoint = getEnv("POSTGRES_BACKUP_ENDPOINT", "")
	c.PostgresBackupSecret = getEnv("POSTGRES_BACKUP_SECRET", "")
	c.PostgresBackupRetention = getEnv("POSTGRES_BACKUP_RETENTION", "14d")
	c.LonghornBackupTarget = strings.TrimSpace(os.Getenv("LONGHORN_BACKUP_TARGET"))
	c.LonghornBackupSecret = strings.TrimSpace(os.Getenv("LONGHORN_BACKUP_SECRET"))
	return c
}

// envFilePath is the saved configuration merged into the environment by Load.
// Tests override it.
var envFilePath = "/etc/platform/.env"

// dotenvLoaded records KEY → value pairs that loadDotEnv injected into the
// process environment, so later Load calls do not mistake them for values
// the operator set explicitly.
var dotenvLoaded = map[string]string{}

// loadDotEnv loads KEY=VALUE pairs into the process environment without
// overwriting variables that are already set.
func loadDotEnv(path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(strings.TrimSuffix(line, "\r"))
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		idx := strings.IndexByte(line, '=')
		if idx <= 0 {
			continue
		}
		key := strings.TrimSpace(line[:idx])
		val := strings.TrimSpace(line[idx+1:])
		if os.Getenv(key) == "" {
			_ = os.Setenv(key, val)
			dotenvLoaded[key] = val
		}
	}
	return nil
}

// UpsertEnvKey sets KEY=value in a dotenv file without rewriting other keys.
func UpsertEnvKey(path, key, value string) error {
	if key == "" {
		return fmt.Errorf("empty env key")
	}
	data, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	lines := []string{}
	if err == nil {
		content := strings.ReplaceAll(string(data), "\r\n", "\n")
		lines = strings.Split(content, "\n")
	}
	prefix := key + "="
	found := false
	for i, line := range lines {
		trim := strings.TrimSpace(line)
		if strings.HasPrefix(trim, prefix) {
			lines[i] = prefix + value
			found = true
		}
	}
	if !found {
		if len(lines) == 0 {
			lines = []string{prefix + value}
		} else if lines[len(lines)-1] == "" {
			lines[len(lines)-1] = prefix + value
			lines = append(lines, "")
		} else {
			lines = append(lines, prefix+value)
		}
	}
	if dir := filepath.Dir(path); dir != "." && dir != "" {
		if err := os.MkdirAll(dir, 0700); err != nil {
			return err
		}
	}
	return WriteFileSync(path, strings.Join(lines, "\n"), 0600)
}

// WriteFileSync writes path with fsync so a crash cannot lose the only copy of a password.
func WriteFileSync(path, content string, mode os.FileMode) error {
	if dir := filepath.Dir(path); dir != "." && dir != "" {
		if err := os.MkdirAll(dir, 0700); err != nil {
			return err
		}
	}
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	if _, err := f.WriteString(content); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		return err
	}
	if d, err := os.Open(filepath.Dir(path)); err == nil {
		_ = d.Sync()
		_ = d.Close()
	}
	return nil
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

func (c *Config) PromptInteractive() error {
	if c.NonInteractive {
		return nil
	}

	color.Cyan("\n  ■ Configuration")
	color.Yellow("    Press Enter to keep the value in [brackets]. Saved under /etc/platform/.env\n")

	domainDefault := c.Domain
	if domainDefault == "" {
		domainDefault = suggestDomain()
	}
	askAlways("Domain (FQDN or <ip>.sslip.io)", &c.Domain, domainDefault)

	emailDefault := c.AdminEmail
	if emailDefault == "" {
		emailDefault = "admin@example.com"
	}
	askAlways("Admin email (login + Let's Encrypt)", &c.AdminEmail, emailDefault)
	c.LEEmail = c.AdminEmail

	askAlways("Platform display name", &c.PlatformName, "Platform")

	hadPassword := c.AdminPassword != ""
	askPasswordOrAuto("Admin password (Enter = auto-generate)", &c.AdminPassword)
	if !hadPassword && c.AdminPassword != "" {
		// Will be finalized in GenerateSecrets if still empty; mark if user typed one.
	}
	if c.AdminPassword == "" {
		c.PasswordGenerated = true
	}

	color.Cyan("\n  ■ Optional components (Y/n)\n")
	askBool("Install ArgoCD (GitOps at /argocd)", &c.InstallArgoCD)
	askBool("Install Monitoring (Grafana + Prometheus)", &c.InstallMonitoring)
	askBool("Install Portainer (portainer.<domain>)", &c.InstallPortainer)
	askBool("Install cert-manager (HTTPS / Let's Encrypt)", &c.InstallCertManager)
	askBool("Enable image auto-update", &c.AutoUpdate)
	askBool("Enable daily release patch upgrades", &c.AutoUpgrade)

	return nil
}

// suggestDomain builds <public-or-primary-ip>.sslip.io when possible.
func suggestDomain() string {
	if ip := publicIPHint(); ip != "" {
		return ip + ".sslip.io"
	}
	return "platform.local"
}

func publicIPHint() string {
	// Prefer a non-loopback IPv4 from local interfaces (VPS primary NIC).
	ifaces, err := net.Interfaces()
	if err != nil {
		return ""
	}
	var fallback string
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := iface.Addrs()
		for _, a := range addrs {
			var ip net.IP
			switch v := a.(type) {
			case *net.IPNet:
				ip = v.IP
			case *net.IPAddr:
				ip = v.IP
			}
			if ip == nil || ip.IsLoopback() {
				continue
			}
			ip = ip.To4()
			if ip == nil {
				continue
			}
			s := ip.String()
			// Prefer public-looking addresses; keep private as fallback.
			if !ip.IsPrivate() {
				return s
			}
			if fallback == "" {
				fallback = s
			}
		}
	}
	return fallback
}

func askAlways(prompt string, target *string, defaultVal string) {
	cur := strings.TrimSpace(*target)
	if cur == "" {
		cur = defaultVal
	}
	fmt.Print(color.CyanString("  ? " + prompt))
	if cur != "" {
		fmt.Print(color.YellowString(" [%s]", cur))
	}
	fmt.Print(": ")
	var input string
	_, _ = fmt.Scanln(&input)
	input = strings.TrimSpace(input)
	if input == "" {
		input = cur
	}
	*target = input
}

func ask(prompt string, target *string, defaultVal string) {
	// Kept for tests / callers that only ask when empty.
	if *target != "" {
		return
	}
	askAlways(prompt, target, defaultVal)
}

func askSecret(prompt string, target *string) {
	if *target != "" {
		return
	}
	fmt.Print(color.CyanString("  ? " + prompt + ": "))
	byteInput, _ := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Println()
	*target = string(byteInput)
}

func askPasswordOrAuto(prompt string, target *string) {
	fmt.Print(color.CyanString("  ? " + prompt))
	if *target != "" {
		fmt.Print(color.YellowString(" [set — Enter keeps, or type new]"))
	}
	fmt.Print(": ")
	byteInput, err := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Println()
	if err != nil {
		// Non-TTY fallback
		var plain string
		_, _ = fmt.Scanln(&plain)
		plain = strings.TrimSpace(plain)
		if plain != "" {
			*target = plain
		}
		return
	}
	input := strings.TrimSpace(string(byteInput))
	if input != "" {
		*target = input
	}
	// empty input → keep existing or leave empty for GenerateSecrets auto-gen
}

func askBool(prompt string, target *bool) {
	def := "Y/n"
	if !*target {
		def = "y/N"
	}
	fmt.Print(color.CyanString("  ? " + prompt))
	fmt.Print(color.YellowString(" [%s]", def))
	fmt.Print(": ")
	var input string
	_, _ = fmt.Scanln(&input)
	input = strings.TrimSpace(strings.ToLower(input))
	if input == "" {
		return
	}
	*target = input == "y" || input == "yes" || input == "true" || input == "1"
}

func (c *Config) GenerateSecrets() {
	if c.SecretsEncryptionKey == "" {
		key := make([]byte, 32)
		if _, err := rand.Read(key); err != nil {
			panic(err)
		}
		c.SecretsEncryptionKey = hex.EncodeToString(key)
	}
	if c.PostgresPassword == "" {
		c.PostgresPassword = generatePassword(24)
	}
	if c.MongoPassword == "" {
		c.MongoPassword = generatePassword(24)
	}
	if c.RedisPassword == "" {
		c.RedisPassword = generatePassword(24)
	}
	if c.MinioSecretKey == "" {
		c.MinioSecretKey = generatePassword(32)
	}
	if len(c.JWTSecret) < 32 {
		c.JWTSecret = generatePassword(48)
	}
	if c.WebhookSecret == "" {
		c.WebhookSecret = generatePassword(32)
	}
	if c.ArgoCDPassword == "" {
		c.ArgoCDPassword = generatePassword(20)
	}
	if c.GrafanaPassword == "" {
		c.GrafanaPassword = generatePassword(20)
	}
	if c.AdminPassword == "" {
		c.AdminPassword = generatePassword(24)
		c.PasswordGenerated = true
	}
	if c.PortainerPassword == "" {
		if len(c.AdminPassword) >= 12 {
			c.PortainerPassword = c.AdminPassword
		} else {
			c.PortainerPassword = generatePassword(20)
		}
	}
	for _, s := range []*string{&c.OIDCSecretGrafana, &c.OIDCSecretArgoCD, &c.OIDCSecretPortainer, &c.OIDCSecretOAuth2Proxy, &c.OIDCSecretMinio} {
		if *s == "" {
			*s = generatePassword(40)
		}
	}
	if c.LEEmail == "" {
		c.LEEmail = c.AdminEmail
	}
	if c.AdminEmail == "" {
		c.AdminEmail = "admin@example.com"
		c.LEEmail = c.AdminEmail
	}
	if c.LEEmail == "" {
		c.LEEmail = c.AdminEmail
	}
	if c.Domain == "" {
		c.Domain = suggestDomain()
	}
}

func (c *Config) SaveEnvFile(path string) error {
	// These numeric settings cross the parent/child boundary through .env.
	for _, value := range []string{c.TelemetryRetentionDays, c.TelemetrySamplingPercentage, c.TelemetryLokiDatasourceUID} {
		if strings.ContainsAny(value, "\r\n") {
			return fmt.Errorf("telemetry settings cannot contain line breaks")
		}
	}
	if strings.ContainsAny(c.LonghornBackupTarget+c.LonghornBackupSecret, "\r\n") {
		return fmt.Errorf("Longhorn backup settings cannot contain line breaks")
	}

	if strings.ContainsAny(c.PostgresHAStorageClass+c.PostgresBackupDestination+c.PostgresBackupEndpoint+c.PostgresBackupSecret+c.PostgresBackupRetention, "\r\n") {
		return fmt.Errorf("PostgreSQL HA settings cannot contain line breaks")
	}
	if idx := strings.LastIndexAny(path, "/\\"); idx != -1 {
		dir := path[:idx]
		if err := os.MkdirAll(dir, 0755); err != nil {
			return fmt.Errorf("create config dir: %w", err)
		}
	}
	var b strings.Builder
	b.WriteString("# Platform configuration generated by platformctl\n")
	b.WriteString(fmt.Sprintf("DOMAIN=%s\n", c.Domain))
	b.WriteString(fmt.Sprintf("ADMIN_EMAIL=%s\n", c.AdminEmail))
	b.WriteString(fmt.Sprintf("LE_EMAIL=%s\n", c.LEEmail))
	b.WriteString(fmt.Sprintf("ADMIN_PASSWORD=%s\n", c.AdminPassword))
	b.WriteString(fmt.Sprintf("PLATFORM_NAME=%s\n", c.PlatformName))
	b.WriteString(fmt.Sprintf("POSTGRES_PASSWORD=%s\n", c.PostgresPassword))
	b.WriteString(fmt.Sprintf("MONGO_PASSWORD=%s\n", c.MongoPassword))
	b.WriteString(fmt.Sprintf("REDIS_PASSWORD=%s\n", c.RedisPassword))
	b.WriteString(fmt.Sprintf("MINIO_ACCESS_KEY=%s\n", c.MinioAccessKey))
	b.WriteString(fmt.Sprintf("MINIO_SECRET_KEY=%s\n", c.MinioSecretKey))
	b.WriteString(fmt.Sprintf("JWT_SECRET=%s\n", c.JWTSecret))
	b.WriteString(fmt.Sprintf("SECRETS_ENCRYPTION_KEY=%s\n", c.SecretsEncryptionKey))
	b.WriteString(fmt.Sprintf("PLATFORM_WEBHOOK_SECRET=%s\n", c.WebhookSecret))
	b.WriteString(fmt.Sprintf("ARGOCD_PASSWORD=%s\n", c.ArgoCDPassword))
	b.WriteString(fmt.Sprintf("GRAFANA_PASSWORD=%s\n", c.GrafanaPassword))
	b.WriteString(fmt.Sprintf("PORTAINER_ADMIN_PASSWORD=%s\n", c.PortainerPassword))
	b.WriteString(fmt.Sprintf("OIDC_SECRET_GRAFANA=%s\n", c.OIDCSecretGrafana))
	b.WriteString(fmt.Sprintf("OIDC_SECRET_ARGOCD=%s\n", c.OIDCSecretArgoCD))
	b.WriteString(fmt.Sprintf("OIDC_SECRET_PORTAINER=%s\n", c.OIDCSecretPortainer))
	b.WriteString(fmt.Sprintf("OIDC_SECRET_OAUTH2_PROXY=%s\n", c.OIDCSecretOAuth2Proxy))
	b.WriteString(fmt.Sprintf("OIDC_SECRET_MINIO=%s\n", c.OIDCSecretMinio))
	b.WriteString(fmt.Sprintf("PLATFORM_IMAGE_TAG=%s\n", c.ImageTag))
	b.WriteString(fmt.Sprintf("AUTO_UPDATE=%t\n", c.AutoUpdate))
	b.WriteString(fmt.Sprintf("AUTO_UPGRADE=%t\n", c.AutoUpgrade))
	b.WriteString(fmt.Sprintf("PLATFORM_HARDEN=%t\nPLATFORM_WAF=%t\n", !c.SkipHardening, c.WAF))
	b.WriteString(fmt.Sprintf("PLATFORM_NGINX_AUTH_JAIL=%t\n", c.NginxAuthJail))
	b.WriteString(fmt.Sprintf("INGRESS_IP_RATE_LIMIT=%d\n", c.IngressIPRateLimit))
	b.WriteString(fmt.Sprintf("INGRESS_IP_BURST=%d\n", c.IngressIPBurst))
	b.WriteString(fmt.Sprintf("INGRESS_IP_CONNECTIONS=%d\n", c.IngressIPConnections))
	b.WriteString(fmt.Sprintf("PLATFORM_PROFILE=%s\n", c.profileName()))
	if c.TelemetrySamplingPercentage != "" {
		b.WriteString(fmt.Sprintf("TELEMETRY_SAMPLING_PERCENTAGE=%s\n", c.TelemetrySamplingPercentage))
	}
	if c.TelemetryLokiDatasourceUID != "" {
		b.WriteString(fmt.Sprintf("TELEMETRY_LOKI_DATASOURCE_UID=%s\n", c.TelemetryLokiDatasourceUID))
	}
	if c.TelemetryRetentionDays != "" {
		b.WriteString(fmt.Sprintf("TELEMETRY_RETENTION_DAYS=%s\n", c.TelemetryRetentionDays))
	}
	if c.APIReplicas > 0 {
		b.WriteString(fmt.Sprintf("API_REPLICAS=%d\n", c.APIReplicas))
	}
	b.WriteString(fmt.Sprintf("INSTALL_ARGOCD=%t\n", c.InstallArgoCD))
	b.WriteString(fmt.Sprintf("INSTALL_MONITORING=%t\n", c.InstallMonitoring))
	b.WriteString(fmt.Sprintf("INSTALL_PORTAINER=%t\n", c.InstallPortainer))
	b.WriteString(fmt.Sprintf("INSTALL_CERTMANAGER=%t\n", c.InstallCertManager))
	b.WriteString(fmt.Sprintf("INSTALL_KYVERNO=%t\n", c.InstallKyverno))
	b.WriteString(fmt.Sprintf("INSTALL_KYVERNO_CVE_POLICY=%t\n", c.InstallKyvernoCVEPolicy))
	b.WriteString(fmt.Sprintf("KYVERNO_POLICY_MODE=%s\n", c.KyvernoPolicyMode))
	cluster, err := c.clusterEnv()
	if err != nil {
		return err
	}
	b.WriteString(cluster)
	b.WriteString(fmt.Sprintf("LONGHORN_REPLICAS=%d\n", c.LonghornReplicas))
	b.WriteString(fmt.Sprintf("LONGHORN_BACKUP_TARGET=%s\n", c.LonghornBackupTarget))
	b.WriteString(fmt.Sprintf("LONGHORN_BACKUP_SECRET=%s\n", c.LonghornBackupSecret))
	// Ingress HA settings only belong on ha-profile installs; keep non-ha .env
	// files byte-stable so profile switches do not leak VIP configuration.
	if c.IsHA() {
		b.WriteString(fmt.Sprintf("POSTGRES_HA_STORAGE_CLASS=%s\n", c.PostgresHAStorageClass))
		b.WriteString(fmt.Sprintf("POSTGRES_BACKUP_DESTINATION=%s\n", c.PostgresBackupDestination))
		b.WriteString(fmt.Sprintf("POSTGRES_BACKUP_ENDPOINT=%s\n", c.PostgresBackupEndpoint))
		b.WriteString(fmt.Sprintf("POSTGRES_BACKUP_SECRET=%s\n", c.PostgresBackupSecret))
		b.WriteString(fmt.Sprintf("POSTGRES_BACKUP_RETENTION=%s\n", c.PostgresBackupRetention))
		b.WriteString(fmt.Sprintf("INGRESS_HA_MODE=%s\n", c.IngressHAMode))
		b.WriteString(fmt.Sprintf("INGRESS_VIP=%s\n", c.IngressVIP))
		b.WriteString(fmt.Sprintf("INGRESS_VIP_INTERFACE=%s\n", c.IngressVIPInterface))
		b.WriteString(fmt.Sprintf("API_VIP=%s\n", c.APIVIP))
	}
	return os.WriteFile(path, []byte(b.String()), 0600)
}

// ResolveIngressHAMode is resolveIngressHAMode for callers that override
// INGRESS_VIP after Load (e.g. `platformctl join --ingress-vip`).
func ResolveIngressHAMode(mode, ingressVIP string) string {
	return resolveIngressHAMode(mode, ingressVIP)
}

// resolveIngressHAMode lower-cases/trims INGRESS_HA_MODE; empty defaults to
// vip when INGRESS_VIP is set, otherwise external.
func resolveIngressHAMode(mode, ingressVIP string) string {
	mode = strings.ToLower(strings.TrimSpace(mode))
	if mode != "" {
		return mode
	}
	if strings.TrimSpace(ingressVIP) != "" {
		return IngressHAModeVIP
	}
	return IngressHAModeExternal
}

// ValidateIngressHA checks ha-profile ingress HA settings. Non-ha profiles
// always pass. Subnet/node-IP checks live in the ingressha package (need host data).
func (c *Config) ValidateIngressHA() error {
	if !c.IsHA() {
		return nil
	}
	for _, v := range []string{c.IngressHAMode, c.IngressVIP, c.IngressVIPInterface, c.APIVIP} {
		if strings.ContainsAny(v, "\r\n") {
			return fmt.Errorf("ingress HA settings cannot contain line breaks")
		}
	}
	mode := strings.ToLower(strings.TrimSpace(c.IngressHAMode))
	switch mode {
	case IngressHAModeVIP, IngressHAModeExternal:
	default:
		return fmt.Errorf("INGRESS_HA_MODE must be %q or %q (got %q)", IngressHAModeVIP, IngressHAModeExternal, c.IngressHAMode)
	}
	if mode != IngressHAModeVIP {
		return nil
	}
	vip, err := netip.ParseAddr(strings.TrimSpace(c.IngressVIP))
	if err != nil || !vip.Is4() {
		return fmt.Errorf("INGRESS_VIP must be a valid IPv4 address (got %q)", c.IngressVIP)
	}
	if c.APIVIP == "" {
		return nil
	}
	api, err := netip.ParseAddr(strings.TrimSpace(c.APIVIP))
	if err != nil || !api.Is4() {
		return fmt.Errorf("API_VIP must be a valid IPv4 address (got %q)", c.APIVIP)
	}
	if api == vip {
		return fmt.Errorf("API_VIP must differ from INGRESS_VIP")
	}
	return nil
}

func getEnv(key, defaultVal string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return defaultVal
}

// getEnvIngressLimit accepts zero as an explicit opt-out. The connection bound
// matches nginx's limit_conn maximum; rate and burst are capped at one million.
func getEnvIngressLimit(key string, defaultVal, max int) int {
	v := os.Getenv(key)
	if v == "" {
		return defaultVal
	}
	n, err := strconv.Atoi(strings.TrimSpace(v))
	if err != nil || n < 0 || n > max {
		fmt.Fprintf(os.Stderr, "platformctl: warning: invalid %s=%q (want 0-%d); using default %d\n", key, v, max, defaultVal)
		return defaultVal
	}
	return n
}

func getEnvBool(key string, defaultVal bool) bool {
	v := os.Getenv(key)
	if v == "" {
		return defaultVal
	}
	return v == "y" || v == "yes" || v == "true" || v == "1"
}

func generatePassword(length int) string {
	b := make([]byte, length)
	rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)[:length]
}

// Install profiles. Explicit INSTALL_* environment variables always override
// the profile's defaults.
const (
	ProfileMinimal  = "minimal"  // core only: no monitoring, Portainer, ArgoCD
	ProfileStandard = "standard" // default: existing light monitoring stack
	ProfileFull     = "full"     // full telemetry backend (explicit opt-in)
	// ProfileHA is the multi-node profile (Phase 5, #50-#54): everything in full,
	// plus k3s HA (embedded etcd), ingress VIP, replicated storage and HA
	// datastores. Single-node installs never select it implicitly.
	ProfileHA = "ha"
)

// Profiles lists the valid profile names.
var Profiles = []string{ProfileMinimal, ProfileStandard, ProfileFull, ProfileHA}

// FullFeatures reports whether a profile includes the full feature set
// (telemetry backend, synthetics, ...): the full and ha profiles.
func FullFeatures(profile string) bool {
	n := normalizeProfile(profile)
	return n == ProfileFull || n == ProfileHA
}

// IsHA reports whether this install uses the multi-node HA profile.
func (c *Config) IsHA() bool { return normalizeProfile(c.Profile) == ProfileHA }

// installKeys are the INSTALL_* variables a profile controls.
var installKeys = []string{"INSTALL_ARGOCD", "INSTALL_MONITORING", "INSTALL_PORTAINER", "INSTALL_CERTMANAGER"}

// profileDefaults returns the Install* values for a profile, keyed by INSTALL_* name.
func profileDefaults(name string) (map[string]bool, error) {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case ProfileMinimal:
		return map[string]bool{
			"INSTALL_ARGOCD": false, "INSTALL_MONITORING": false, "INSTALL_PORTAINER": false,
			"INSTALL_CERTMANAGER": true,
		}, nil
	case "", ProfileStandard:
		return map[string]bool{
			"INSTALL_ARGOCD": true, "INSTALL_MONITORING": true, "INSTALL_PORTAINER": true,
			"INSTALL_CERTMANAGER": true,
		}, nil
	case ProfileFull, ProfileHA:
		return map[string]bool{
			"INSTALL_ARGOCD": true, "INSTALL_MONITORING": true, "INSTALL_PORTAINER": true,
			"INSTALL_CERTMANAGER": true,
		}, nil
	}
	return nil, fmt.Errorf("unknown profile %q (valid: %s)", name, strings.Join(Profiles, ", "))
}

// explicitEnv returns PLATFORM_PROFILE and INSTALL_* values present in the
// process environment that were not injected by an earlier loadDotEnv.
func explicitEnv() map[string]string {
	out := map[string]string{}
	for _, k := range append([]string{"PLATFORM_PROFILE"}, installKeys...) {
		v := os.Getenv(k)
		if v == "" {
			continue
		}
		if loaded, ok := dotenvLoaded[k]; ok && loaded == v {
			continue
		}
		out[k] = v
	}
	return out
}

// resolveProfile sets Profile and the Install* fields during Load.
//
// Precedence (highest first):
//  1. INSTALL_* set explicitly in the process environment.
//  2. INSTALL_* saved in /etc/platform/.env — only when the profile was NOT
//     chosen explicitly this run (the saved values are the operator's earlier
//     per-component choices for the saved profile). When PLATFORM_PROFILE is
//     set explicitly, saved INSTALL_* values are ignored so a newly chosen
//     profile is not silently overridden by a previous SaveEnvFile.
//  3. The profile's defaults (explicit PLATFORM_PROFILE, else the saved one,
//     else "standard").
func (c *Config) resolveProfile(explicit map[string]string) {
	c.explicitInstall = map[string]bool{}
	for _, k := range installKeys {
		if v, ok := explicit[k]; ok {
			c.explicitInstall[k] = parseBool(v)
		}
	}

	name, profileExplicit := explicit["PLATFORM_PROFILE"]
	if !profileExplicit {
		name = os.Getenv("PLATFORM_PROFILE") // from .env, if any
	}
	defaults, err := profileDefaults(name)
	if err != nil {
		fmt.Fprintf(os.Stderr, "platformctl: %v; using %q\n", err, ProfileStandard)
		name = ProfileStandard
		defaults, _ = profileDefaults(name)
	}
	c.Profile = normalizeProfile(name)

	if !profileExplicit {
		// Saved per-component choices from a previous run refine the saved profile.
		for _, k := range installKeys {
			if v, ok := dotenvLoaded[k]; ok && os.Getenv(k) == v {
				defaults[k] = parseBool(v)
			}
		}
	}
	c.setInstall(defaults)
}

// ApplyProfile switches to the named profile (minimal|standard|full), e.g.
// from a --profile flag. It resets every Install* field to the profile's
// defaults, discarding values loaded from /etc/platform/.env, then re-applies
// INSTALL_* variables set explicitly in the process environment.
func (c *Config) ApplyProfile(name string) error {
	defaults, err := profileDefaults(name)
	if err != nil {
		return err
	}
	c.Profile = normalizeProfile(name)
	c.setInstall(defaults)
	c.APIReplicas = profileAPIReplicas(c.Profile)
	if c.explicitAPIReplicas > 0 {
		c.APIReplicas = c.explicitAPIReplicas
	}
	c.resolveKyverno()
	return nil
}

// resolveKyverno sets Kyverno-related flags. Kyverno is never part of a
// profile default: it requires an explicit INSTALL_KYVERNO=true and a full
// profile so single-server installs stay light.
func (c *Config) resolveKyverno() {
	// Browser synthetic checks (#42) follow the same rule: explicit opt-in, full profile only.
	c.SyntheticsBrowser = FullFeatures(c.Profile) && getEnvBool("SYNTHETICS_BROWSER", false)
	c.InstallKyverno = FullFeatures(c.Profile) && getEnvBool("INSTALL_KYVERNO", false)
	c.InstallKyvernoCVEPolicy = getEnvBool("INSTALL_KYVERNO_CVE_POLICY", false)
	mode := strings.TrimSpace(getEnv("KYVERNO_POLICY_MODE", "Audit"))
	switch strings.ToLower(mode) {
	case "enforce":
		c.KyvernoPolicyMode = "Enforce"
	default:
		c.KyvernoPolicyMode = "Audit"
	}
}

// MaxAPIReplicas bounds API_REPLICAS.
const MaxAPIReplicas = 10

// profileAPIReplicas is the platform-api replica count for a profile: one on
// minimal (very small servers), two elsewhere for zero-downtime rollouts.
func profileAPIReplicas(profile string) int {
	if normalizeProfile(profile) == ProfileMinimal {
		return 1
	}
	return 2
}

// parseAPIReplicas returns n for a valid API_REPLICAS value, else 0.
func parseAPIReplicas(v string) int {
	n, err := strconv.Atoi(strings.TrimSpace(v))
	if err != nil || n < 1 || n > MaxAPIReplicas {
		return 0
	}
	return n
}

// explicitAPIReplicasEnv returns API_REPLICAS when set in the real process
// environment (not injected from /etc/platform/.env by an earlier Load).
func explicitAPIReplicasEnv() int {
	v := os.Getenv("API_REPLICAS")
	if v == "" {
		return 0
	}
	if loaded, ok := dotenvLoaded["API_REPLICAS"]; ok && loaded == v {
		return 0
	}
	n := parseAPIReplicas(v)
	if n == 0 {
		fmt.Fprintf(os.Stderr, "platformctl: ignoring API_REPLICAS=%q (want 1-%d)\n", v, MaxAPIReplicas)
	}
	return n
}

// resolveAPIReplicas mirrors resolveProfile's precedence: explicit env, then the
// saved value (unless a profile was chosen explicitly this run), then the
// profile default.
func (c *Config) resolveAPIReplicas(explicit int, profileExplicit bool) {
	c.explicitAPIReplicas = explicit
	if explicit > 0 {
		c.APIReplicas = explicit
		return
	}
	if !profileExplicit {
		if saved, ok := dotenvLoaded["API_REPLICAS"]; ok && os.Getenv("API_REPLICAS") == saved {
			if n := parseAPIReplicas(saved); n > 0 {
				c.APIReplicas = n
				return
			}
		}
	}
	c.APIReplicas = profileAPIReplicas(c.Profile)
}

func (c *Config) setInstall(defaults map[string]bool) {
	for k, v := range c.explicitInstall {
		defaults[k] = v
	}
	c.InstallArgoCD = defaults["INSTALL_ARGOCD"]
	c.InstallMonitoring = defaults["INSTALL_MONITORING"]
	c.InstallPortainer = defaults["INSTALL_PORTAINER"]
	c.InstallCertManager = defaults["INSTALL_CERTMANAGER"]
}

func (c *Config) profileName() string {
	if c.Profile == "" {
		return ProfileStandard
	}
	return c.Profile
}

func normalizeProfile(name string) string {
	n := strings.ToLower(strings.TrimSpace(name))
	if n == "" {
		return ProfileStandard
	}
	return n
}

func parseBool(v string) bool {
	return v == "y" || v == "yes" || v == "true" || v == "1"
}
