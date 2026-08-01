package config

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"net"
	"os"
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

	ImageRegistry string
	ImageTag      string
	RepoURL       string
	GitHubToken   string

	InstallArgoCD      bool
	InstallMonitoring  bool
	InstallPortainer   bool
	InstallInfisical   bool
	InstallCertManager bool
	AutoUpdate         bool

	PostgresPassword  string
	MongoPassword     string
	RedisPassword     string
	MinioAccessKey    string
	MinioSecretKey    string
	JWTSecret         string
	WebhookSecret     string
	ArgoCDPassword    string
	GrafanaPassword   string
	InfisicalEncKey   string
	InfisicalJWT      string
	PortainerPassword string
	LEEmail           string

	// PasswordGenerated is set when admin password was auto-created this run.
	PasswordGenerated bool
}

func Load() *Config {
	tagDefault := DefaultImageTag
	if tagDefault == "" {
		tagDefault = "latest"
	}
	// Prefer values already written by a prior provision.
	_ = loadDotEnv("/etc/platform/.env")

	c := &Config{
		PlatformName:       getEnv("PLATFORM_NAME", "Platform"),
		ImageRegistry:      getEnv("PLATFORM_IMAGE_REGISTRY", "ghcr.io/mpratyush54"),
		ImageTag:           getEnv("PLATFORM_IMAGE_TAG", tagDefault),
		RepoURL:            getEnv("PLATFORM_REPO_URL", "https://github.com/Mpratyush54/SERVER-automation"),
		GitHubToken:        getEnv("GITHUB_TOKEN", ""),
		Domain:             firstNonEmpty(os.Getenv("DOMAIN"), os.Getenv("PLATFORM_DOMAIN")),
		AdminEmail:         os.Getenv("ADMIN_EMAIL"), // empty → prompt will ask
		AdminPassword:      getEnv("ADMIN_PASSWORD", ""),
		NonInteractive:     os.Getenv("NON_INTERACTIVE") == "true" || os.Getenv("PLATFORMCTL_AUTO") == "true",
		SkipK8s:            os.Getenv("SKIP_K8S") == "true",
		SkipPreflight:      os.Getenv("SKIP_PREFLIGHT") == "true",
		InstallArgoCD:      getEnvBool("INSTALL_ARGOCD", true),
		InstallMonitoring:  getEnvBool("INSTALL_MONITORING", true),
		InstallPortainer:   getEnvBool("INSTALL_PORTAINER", true),
		InstallInfisical:   getEnvBool("INSTALL_INFISICAL", true),
		InstallCertManager: getEnvBool("INSTALL_CERTMANAGER", true),
		AutoUpdate:         getEnvBool("AUTO_UPDATE", true),
		MinioAccessKey:     getEnv("MINIO_ACCESS_KEY", "platformadmin"),
		PostgresPassword:   os.Getenv("POSTGRES_PASSWORD"),
		MongoPassword:      os.Getenv("MONGO_PASSWORD"),
		RedisPassword:      os.Getenv("REDIS_PASSWORD"),
		MinioSecretKey:     os.Getenv("MINIO_SECRET_KEY"),
		JWTSecret:          os.Getenv("JWT_SECRET"),
		WebhookSecret:      os.Getenv("PLATFORM_WEBHOOK_SECRET"),
		ArgoCDPassword:     os.Getenv("ARGOCD_PASSWORD"),
		GrafanaPassword:    os.Getenv("GRAFANA_PASSWORD"),
		PortainerPassword:  firstNonEmpty(os.Getenv("PORTAINER_ADMIN_PASSWORD"), os.Getenv("PORTAINER_PASSWORD")),
		LEEmail:            firstNonEmpty(os.Getenv("LE_EMAIL"), os.Getenv("ADMIN_EMAIL")),
	}
	return c
}

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
		}
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
	askBool("Install Infisical (secrets)", &c.InstallInfisical)
	askBool("Install cert-manager (HTTPS / Let's Encrypt)", &c.InstallCertManager)
	askBool("Enable image auto-update", &c.AutoUpdate)

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
	if c.JWTSecret == "" {
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
	if c.InfisicalEncKey == "" {
		c.InfisicalEncKey = generatePassword(64)
	}
	if c.InfisicalJWT == "" {
		c.InfisicalJWT = generatePassword(48)
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
	b.WriteString(fmt.Sprintf("PLATFORM_WEBHOOK_SECRET=%s\n", c.WebhookSecret))
	b.WriteString(fmt.Sprintf("ARGOCD_PASSWORD=%s\n", c.ArgoCDPassword))
	b.WriteString(fmt.Sprintf("GRAFANA_PASSWORD=%s\n", c.GrafanaPassword))
	b.WriteString(fmt.Sprintf("INFISICAL_ENCRYPTION_KEY=%s\n", c.InfisicalEncKey))
	b.WriteString(fmt.Sprintf("INFISICAL_JWT_SECRET=%s\n", c.InfisicalJWT))
	b.WriteString(fmt.Sprintf("PORTAINER_ADMIN_PASSWORD=%s\n", c.PortainerPassword))
	b.WriteString(fmt.Sprintf("PLATFORM_IMAGE_TAG=%s\n", c.ImageTag))
	b.WriteString(fmt.Sprintf("AUTO_UPDATE=%t\n", c.AutoUpdate))
	b.WriteString(fmt.Sprintf("INSTALL_ARGOCD=%t\n", c.InstallArgoCD))
	b.WriteString(fmt.Sprintf("INSTALL_MONITORING=%t\n", c.InstallMonitoring))
	b.WriteString(fmt.Sprintf("INSTALL_PORTAINER=%t\n", c.InstallPortainer))
	b.WriteString(fmt.Sprintf("INSTALL_INFISICAL=%t\n", c.InstallInfisical))
	b.WriteString(fmt.Sprintf("INSTALL_CERTMANAGER=%t\n", c.InstallCertManager))
	return os.WriteFile(path, []byte(b.String()), 0600)
}

func getEnv(key, defaultVal string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return defaultVal
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
