package components

import (
	"fmt"
	"os"
	"strings"

	"github.com/fatih/color"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/manifests"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/shell"
)

type Component struct {
	Name        string
	Description string
	Install     func(cfg *config.Config) error
}

func All() []Component {
	return []Component{
		{"ingress-nginx", "Kubernetes Ingress Controller", InstallIngressNginx},
		{"cert-manager", "Let's Encrypt certificate management", InstallCertManager},
		{"postgresql", "PostgreSQL database", InstallPostgreSQL},
		{"mongodb", "MongoDB database", InstallMongoDB},
		{"redis", "Redis cache", InstallRedis},
		{"minio", "S3-compatible object storage", InstallMinIO},
		{"argocd", "ArgoCD GitOps", InstallArgoCD},
		{"monitoring", "Grafana + Prometheus + Loki", InstallMonitoring},
		{"oauth2-proxy", "OAuth2 authentication proxy", InstallOAuthProxy},
		{"portainer", "Container management UI", InstallPortainer},
		{"infisical", "Secret management", InstallInfisical},
		{"platform", "Platform API + Portal", InstallPlatform},
	}
}

func Find(name string) *Component {
	for _, c := range All() {
		if c.Name == name {
			return &c
		}
	}
	return nil
}

func Namespace() error {
	return shell.RunBash("kubectl create namespace platform --dry-run=client -o yaml | kubectl apply -f -")
}

func readManifest(name string) string {
	data, err := manifests.Read(name)
	if err != nil {
		color.Yellow("  ⚠ Manifest %s not found", name)
		return ""
	}
	return string(data)
}

func InstallIngressNginx(cfg *config.Config) error {
	color.Cyan("\n  ■ Installing ingress-nginx...")
	defer color.Green("  ✓ ingress-nginx installed")

	return shell.RunBash(`
		helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
			--namespace ingress-nginx --create-namespace \
			--set controller.publishService.enabled=true \
			--wait --timeout 10m
	`)
}

func InstallCertManager(cfg *config.Config) error {
	color.Cyan("\n  ■ Installing cert-manager...")
	defer color.Green("  ✓ cert-manager installed")

	cmds := []string{
		fmt.Sprintf(`helm upgrade --install cert-manager jetstack/cert-manager \
			--namespace cert-manager --create-namespace \
			--set installCRDs=true --wait --timeout 5m`),
		fmt.Sprintf(`kubectl apply -f - <<EOF
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: %s
    privateKeySecretRef:
      name: letsencrypt-prod
    solvers:
    - http01:
        ingress:
          class: nginx
EOF`, cfg.LEEmail),
	}

	for _, c := range cmds {
		if err := shell.RunBash(c); err != nil {
			return err
		}
	}
	return nil
}

func InstallPostgreSQL(cfg *config.Config) error {
	color.Cyan("\n  ■ Installing PostgreSQL...")
	defer color.Green("  ✓ PostgreSQL installed")

	return shell.RunBash(fmt.Sprintf(`
		helm upgrade --install postgresql bitnami/postgresql \
			--namespace platform \
			--set auth.postgresPassword=%s \
			--set auth.database=platform \
			--set primary.persistence.size=10Gi \
			--wait --timeout 10m
	`, cfg.PostgresPassword))
}

func InstallMongoDB(cfg *config.Config) error {
	color.Cyan("\n  ■ Installing MongoDB...")
	defer color.Green("  ✓ MongoDB installed")

	return shell.RunBash(fmt.Sprintf(`
		helm upgrade --install mongodb bitnami/mongodb \
			--namespace platform \
			--set auth.rootPassword=%s \
			--set persistence.size=10Gi \
			--wait --timeout 10m
	`, cfg.MongoPassword))
}

func InstallRedis(cfg *config.Config) error {
	color.Cyan("\n  ■ Installing Redis...")
	defer color.Green("  ✓ Redis installed")

	return shell.RunBash(fmt.Sprintf(`
		helm upgrade --install redis bitnami/redis \
			--namespace platform \
			--set auth.password=%s \
			--set master.persistence.size=5Gi \
			--wait --timeout 10m
	`, cfg.RedisPassword))
}

func InstallMinIO(cfg *config.Config) error {
	color.Cyan("\n  ■ Installing MinIO...")
	defer color.Green("  ✓ MinIO installed")

	vals := readManifest("minio-values.yaml")
	if vals == "" {
		return fmt.Errorf("minio-values.yaml manifest not found")
	}

	tmpFile := "/tmp/minio-values.yaml"
	os.WriteFile(tmpFile, []byte(vals), 0644)
	defer os.Remove(tmpFile)

	return shell.RunBash(fmt.Sprintf(`
		helm upgrade --install minio minio/minio-operator \
			--namespace platform --create-namespace \
			-f %s \
			--set secrets.accessKey=%s \
			--set secrets.secretKey=%s \
			--wait --timeout 10m
	`, tmpFile, cfg.MinioAccessKey, cfg.MinioSecretKey))
}

func InstallArgoCD(cfg *config.Config) error {
	color.Cyan("\n  ■ Installing ArgoCD...")
	defer color.Green("  ✓ ArgoCD installed")

	vals := readManifest("argocd-values.yaml")
	tmpFile := "/tmp/argocd-values.yaml"
	os.WriteFile(tmpFile, []byte(vals), 0644)
	defer os.Remove(tmpFile)

	cmds := []string{
		fmt.Sprintf(`
			helm upgrade --install argocd argo/argo-cd \
				--namespace argocd --create-namespace \
				-f %s \
				--set configs.secret.argocdServerAdminPassword=%s \
				--wait --timeout 10m
		`, tmpFile, cfg.ArgoCDPassword),
		`kubectl apply -f - <<EOF
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: argocd
  namespace: argocd
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  ingressClassName: nginx
  rules:
  - host: argocd.` + cfg.Domain + `
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: argocd-server
            port:
              number: 80
  tls:
  - hosts:
    - argocd.` + cfg.Domain + `
    secretName: argocd-tls
EOF`,
	}

	for _, c := range cmds {
		if err := shell.RunBash(c); err != nil {
			return err
		}
	}
	return nil
}

func InstallMonitoring(cfg *config.Config) error {
	color.Cyan("\n  ■ Installing monitoring stack...")
	defer color.Green("  ✓ Monitoring stack installed")

	grafanaVals := readManifest("grafana-values.yaml")
	grafanaFile := "/tmp/grafana-values.yaml"
	os.WriteFile(grafanaFile, []byte(grafanaVals), 0644)
	defer os.Remove(grafanaFile)

	cmds := []string{
		fmt.Sprintf(`
			helm upgrade --install loki grafana/loki \
				--namespace monitoring --create-namespace \
				--set persistence.enabled=true \
				--set persistence.size=10Gi \
				--wait --timeout 10m
		`),
		fmt.Sprintf(`
			helm upgrade --install prometheus prometheus-community/prometheus \
				--namespace monitoring \
				--set alertmanager.enabled=false \
				--set server.persistentVolume.size=10Gi \
				--wait --timeout 10m
		`),
		fmt.Sprintf(`
			helm upgrade --install grafana grafana/grafana \
				--namespace monitoring \
				-f %s \
				--set adminPassword=%s \
				--wait --timeout 10m
		`, grafanaFile, cfg.GrafanaPassword),
	}

	for _, c := range cmds {
		if err := shell.RunBash(c); err != nil {
			return err
		}
	}
	return nil
}

func InstallOAuthProxy(cfg *config.Config) error {
	color.Cyan("\n  ■ Installing oauth2-proxy...")
	defer color.Green("  ✓ oauth2-proxy installed")

	vals := readManifest("oauth2-proxy-values.yaml")
	if vals == "" {
		return fmt.Errorf("oauth2-proxy-values.yaml manifest not found, skipping")
	}

	tmpFile := "/tmp/oauth2-values.yaml"
	os.WriteFile(tmpFile, []byte(vals), 0644)
	defer os.Remove(tmpFile)

	return shell.RunBash(fmt.Sprintf(`
		helm upgrade --install oauth2-proxy oauth2-proxy/oauth2-proxy \
			--namespace platform \
			-f %s \
			--wait --timeout 5m
	`, tmpFile))
}

func InstallPortainer(cfg *config.Config) error {
	color.Cyan("\n  ■ Installing Portainer...")
	defer color.Green("  ✓ Portainer installed")

	vals := readManifest("portainer-values.yaml")
	tmpFile := "/tmp/portainer-values.yaml"
	os.WriteFile(tmpFile, []byte(vals), 0644)
	defer os.Remove(tmpFile)

	return shell.RunBash(fmt.Sprintf(`
		helm upgrade --install portainer portainer/portainer \
			--namespace portainer --create-namespace \
			-f %s \
			--set service.type=ClusterIP \
			--wait --timeout 5m
	`, tmpFile))
}

func InstallInfisical(cfg *config.Config) error {
	color.Cyan("\n  ■ Installing Infisical...")
	defer color.Green("  ✓ Infisical installed")

	vals := readManifest("infisical.yaml")
	tmpFile := "/tmp/infisical.yaml"
	os.WriteFile(tmpFile, []byte(vals), 0644)
	defer os.Remove(tmpFile)

	return shell.RunBash(fmt.Sprintf(`
		helm upgrade --install infisical infisical/infisical \
			--namespace infisical --create-namespace \
			-f %s \
			--set auth.secret=%s \
			--set encryptionKey=%s \
			--set jwtSecret=%s \
			--wait --timeout 10m
	`, tmpFile, cfg.WebhookSecret, cfg.InfisicalEncKey, cfg.InfisicalJWT))
}

func InstallPlatform(cfg *config.Config) error {
	color.Cyan("\n  ■ Deploying Platform API + Portal...")
	defer color.Green("  ✓ Platform deployed")

	cmds := []string{
		fmt.Sprintf(`
			kubectl apply -f - <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: platform-api
  namespace: platform
spec:
  replicas: 2
  selector:
    matchLabels:
      app: platform-api
  template:
    metadata:
      labels:
        app: platform-api
    spec:
      containers:
      - name: api
        image: %s/platform-api:%s
        ports:
        - containerPort: 3000
        env:
        - name: DOMAIN
          value: "%s"
        - name: JWT_SECRET
          value: "%s"
        - name: POSTGRES_PASSWORD
          value: "%s"
        - name: MONGO_PASSWORD
          value: "%s"
        - name: REDIS_PASSWORD
          value: "%s"
        - name: MINIO_ACCESS_KEY
          value: "%s"
        - name: MINIO_SECRET_KEY
          value: "%s"
        livenessProbe:
          httpGet:
            path: /api/health
            port: 3000
        readinessProbe:
          httpGet:
            path: /api/health
            port: 3000
EOF`,
			cfg.ImageRegistry, cfg.ImageTag,
			cfg.Domain, cfg.JWTSecret,
			cfg.PostgresPassword, cfg.MongoPassword,
			cfg.RedisPassword, cfg.MinioAccessKey, cfg.MinioSecretKey,
		),
		fmt.Sprintf(`
			kubectl apply -f - <<EOF
apiVersion: v1
kind: Service
metadata:
  name: platform-api
  namespace: platform
spec:
  selector:
    app: platform-api
  ports:
  - port: 3000
    targetPort: 3000
EOF`),
		fmt.Sprintf(`
			kubectl apply -f - <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: platform-portal
  namespace: platform
spec:
  replicas: 2
  selector:
    matchLabels:
      app: platform-portal
  template:
    metadata:
      labels:
        app: platform-portal
    spec:
      containers:
      - name: portal
        image: %s/platform-portal:%s
        ports:
        - containerPort: 80
        livenessProbe:
          httpGet:
            path: /
            port: 80
        readinessProbe:
          httpGet:
            path: /
            port: 80
EOF`,
			cfg.ImageRegistry, cfg.ImageTag,
		),
		fmt.Sprintf(`
			kubectl apply -f - <<EOF
apiVersion: v1
kind: Service
metadata:
  name: platform-portal
  namespace: platform
spec:
  selector:
    app: platform-portal
  ports:
  - port: 80
    targetPort: 80
EOF`),
		fmt.Sprintf(`
			kubectl apply -f - <<EOF
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: platform
  namespace: platform
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  ingressClassName: nginx
  rules:
  - host: %s
    http:
      paths:
      - path: /api/
        pathType: Prefix
        backend:
          service:
            name: platform-api
            port:
              number: 3000
      - path: /
        pathType: Prefix
        backend:
          service:
            name: platform-portal
            port:
              number: 80
  tls:
  - hosts:
    - %s
    secretName: platform-tls
EOF`, cfg.Domain, cfg.Domain),
	}

	for _, c := range cmds {
		if err := shell.RunBash(c); err != nil {
			return err
		}
	}
	return nil
}

func SeedAdmin(cfg *config.Config) error {
	color.Cyan("\n  ■ Seeding admin user...")
	defer color.Green("  ✓ Admin user seeded")

	pod := "deployment/platform-api"
	cmds := []string{
		fmt.Sprintf(`kubectl exec -n platform %s -- sh -c '
			curl -s -X POST http://localhost:3000/api/seed \
			-H "Content-Type: application/json" \
			-d "{\"domain\":\"%s\",\"email\":\"%s\",\"password\":\"%s\"}"
		'`, pod, cfg.Domain, cfg.AdminEmail, generateDemoPassword()),
	}
	for _, c := range cmds {
		if err := shell.RunBash(c); err != nil {
			return fmt.Errorf("seed admin failed: %w", err)
		}
	}
	return nil
}

func generateDemoPassword() string {
	return "admin123"
}

func ProvisionComplete(cfg *config.Config) {
	color.Green("\n  ========================================")
	color.Green("   Platform provisioned successfully!")
	color.Green("  ========================================")
	color.Cyan("\n  Access URLs:")
	fmt.Printf("    Portal:   https://%s\n", cfg.Domain)
	fmt.Printf("    ArgoCD:   https://argocd.%s\n", cfg.Domain)
	fmt.Printf("    Grafana:  https://grafana.%s (admin/%s)\n", cfg.Domain, cfg.GrafanaPassword)
	fmt.Printf("    Portainer: https://portainer.%s\n", cfg.Domain)
	fmt.Printf("    MinIO:    https://minio.%s\n", cfg.Domain)
	color.Cyan("\n  Useful commands:")
	fmt.Printf("    Kubeconfig: export KUBECONFIG=/etc/rancher/k3s/k3s.yaml\n")
	fmt.Printf("    Dashboard:  k3s kubectl get all -n platform\n")
}

func CheckHealth() error {
	type check struct {
		name string
		cmd  string
	}
	checks := []check{
		{"K3s nodes", "k3s kubectl get nodes --no-headers 2>/dev/null | grep -q Ready"},
		{"Platform API", "k3s kubectl get deployment -n platform platform-api --no-headers 2>/dev/null | grep -q '1/1'"},
		{"Platform Portal", "k3s kubectl get deployment -n platform platform-portal --no-headers 2>/dev/null | grep -q '1/1'"},
		{"Ingress NGINX", "k3s kubectl get deployment -n ingress-nginx ingress-nginx-controller --no-headers 2>/dev/null | grep -q '1/1'"},
		{"ArgoCD", "k3s kubectl get deployment -n argocd argocd-server --no-headers 2>/dev/null | grep -q '1/1'"},
	}

	var failed []string
	for _, c := range checks {
		if err := shell.RunBash(c.cmd); err != nil {
			failed = append(failed, c.name)
			color.Red("  ✗ %s", c.name)
		} else {
			color.Green("  ✓ %s", c.name)
		}
	}

	if len(failed) > 0 {
		return fmt.Errorf("unhealthy components: %s", strings.Join(failed, ", "))
	}
	return nil
}
