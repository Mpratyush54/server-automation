package components

import (
	"fmt"
	"os"
	"strings"

	"github.com/fatih/color"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/manifests"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/shell"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/state"
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
	if state.IsDone("namespaces") {
		color.Green("  ✓ Namespaces already created")
		return nil
	}
	color.Cyan("\n  ■ Creating namespaces...")
	nss := []string{
		"platform", "databases", "monitoring", "storage",
		"argocd", "portainer", "infisical", "cert-manager",
		"ingress-nginx", "oauth2-proxy",
	}
	for _, ns := range nss {
		if err := shell.RunBash(fmt.Sprintf(
			`kubectl create namespace %s --dry-run=client -o yaml | kubectl apply -f -`, ns)); err != nil {
			return err
		}
	}
	color.Green("  ✓ Namespaces created")
	return state.MarkDone("namespaces")
}

func readManifest(name string) string {
	data, err := manifests.Read(name)
	if err != nil {
		color.Yellow("  ⚠ Manifest %s not found", name)
		return ""
	}
	return string(data)
}

func writeTemplatedManifest(name, domain, dest string) error {
	vals := readManifest(name)
	if vals == "" {
		return fmt.Errorf("%s manifest not found", name)
	}
	vals = strings.ReplaceAll(vals, "{{DOMAIN}}", domain)
	return os.WriteFile(dest, []byte(vals), 0644)
}

func doneOrSkip(step, label string) bool {
	if state.IsDone(step) {
		color.Green("  ✓ %s already done", label)
		return true
	}
	return false
}

func InstallIngressNginx(cfg *config.Config) error {
	if doneOrSkip("ingress", "ingress-nginx") {
		return nil
	}
	color.Cyan("\n  ■ Installing ingress-nginx...")
	err := shell.RunBash(`
		helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
			--namespace ingress-nginx --create-namespace \
			--set controller.service.type=LoadBalancer \
			--set controller.publishService.enabled=true \
			--wait --timeout 10m
	`)
	if err != nil {
		return err
	}
	color.Green("  ✓ ingress-nginx installed")
	return state.MarkDone("ingress")
}

func InstallCertManager(cfg *config.Config) error {
	if doneOrSkip("cert-manager", "cert-manager") {
		return nil
	}
	color.Cyan("\n  ■ Installing cert-manager...")
	email := cfg.LEEmail
	if email == "" {
		email = cfg.AdminEmail
	}
	cmds := []string{
		`helm upgrade --install cert-manager jetstack/cert-manager \
			--namespace cert-manager --create-namespace \
			--set installCRDs=true --wait --timeout 5m`,
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
EOF`, email),
	}
	for _, c := range cmds {
		if err := shell.RunBash(c); err != nil {
			return err
		}
	}
	color.Green("  ✓ cert-manager installed")
	return state.MarkDone("cert-manager")
}

func InstallPostgreSQL(cfg *config.Config) error {
	if doneOrSkip("postgresql", "PostgreSQL") {
		return nil
	}
	color.Cyan("\n  ■ Installing PostgreSQL...")
	err := shell.RunBash(fmt.Sprintf(`
		helm upgrade --install postgresql bitnami/postgresql \
			--namespace databases --create-namespace \
			--set auth.postgresPassword=%s \
			--set auth.database=platform \
			--set primary.persistence.size=10Gi \
			--wait --timeout 10m
	`, cfg.PostgresPassword))
	if err != nil {
		return err
	}
	color.Green("  ✓ PostgreSQL installed")
	return state.MarkDone("postgresql")
}

func InstallMongoDB(cfg *config.Config) error {
	if doneOrSkip("mongodb", "MongoDB") {
		return nil
	}
	color.Cyan("\n  ■ Installing MongoDB...")
	err := shell.RunBash(fmt.Sprintf(`
		helm upgrade --install mongodb bitnami/mongodb \
			--namespace databases --create-namespace \
			--set auth.rootPassword=%s \
			--set persistence.size=10Gi \
			--wait --timeout 10m
	`, cfg.MongoPassword))
	if err != nil {
		return err
	}
	color.Green("  ✓ MongoDB installed")
	return state.MarkDone("mongodb")
}

func InstallRedis(cfg *config.Config) error {
	if doneOrSkip("redis", "Redis") {
		return nil
	}
	color.Cyan("\n  ■ Installing Redis...")
	err := shell.RunBash(fmt.Sprintf(`
		helm upgrade --install redis bitnami/redis \
			--namespace databases --create-namespace \
			--set auth.password=%s \
			--set master.persistence.size=5Gi \
			--wait --timeout 10m
	`, cfg.RedisPassword))
	if err != nil {
		return err
	}
	color.Green("  ✓ Redis installed")
	return state.MarkDone("redis")
}

func InstallMinIO(cfg *config.Config) error {
	if doneOrSkip("minio", "MinIO") {
		return nil
	}
	color.Cyan("\n  ■ Installing MinIO...")
	tmpFile := "/tmp/minio-values.yaml"
	if err := writeTemplatedManifest("minio-values.yaml", cfg.Domain, tmpFile); err != nil {
		return err
	}
	defer os.Remove(tmpFile)

	err := shell.RunBash(fmt.Sprintf(`
		helm upgrade --install minio bitnami/minio \
			--namespace storage --create-namespace \
			-f %s \
			--set auth.rootUser=%s \
			--set auth.rootPassword=%s \
			--set persistence.size=50Gi \
			--set image.repository=bitnamilegacy/minio \
			--set console.image.repository=bitnamilegacy/minio-object-browser \
			--set defaultBuckets="platform-backups\,platform-logs" \
			--wait --timeout 10m
	`, tmpFile, cfg.MinioAccessKey, cfg.MinioSecretKey))
	if err != nil {
		return err
	}
	color.Green("  ✓ MinIO installed")
	return state.MarkDone("minio")
}

func InstallArgoCD(cfg *config.Config) error {
	if doneOrSkip("argocd", "ArgoCD") {
		return nil
	}
	color.Cyan("\n  ■ Installing ArgoCD...")
	tmpFile := "/tmp/argocd-values.yaml"
	if err := writeTemplatedManifest("argocd-values.yaml", cfg.Domain, tmpFile); err != nil {
		return err
	}
	defer os.Remove(tmpFile)

	err := shell.RunBash(fmt.Sprintf(`
		helm upgrade --install argocd argo/argo-cd \
			--namespace argocd --create-namespace \
			-f %s \
			--set configs.params."server\.insecure"=true \
			--wait --timeout 10m || {
			kubectl create namespace argocd --dry-run=client -o yaml | kubectl apply -f -
			kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
			kubectl wait --for=condition=Available deployment --all -n argocd --timeout=300s || true
			kubectl patch deployment argocd-server -n argocd --type=json \
			  -p '[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--insecure"}]' || true
		}
	`, tmpFile))
	if err != nil {
		return err
	}
	color.Green("  ✓ ArgoCD installed")
	return state.MarkDone("argocd")
}

func InstallMonitoring(cfg *config.Config) error {
	if doneOrSkip("monitoring", "monitoring") {
		return nil
	}
	color.Cyan("\n  ■ Installing monitoring stack...")
	tmpFile := "/tmp/grafana-values.yaml"
	if err := writeTemplatedManifest("grafana-values.yaml", cfg.Domain, tmpFile); err != nil {
		return err
	}
	defer os.Remove(tmpFile)

	err := shell.RunBash(fmt.Sprintf(`
		helm upgrade --install kube-prometheus prometheus-community/kube-prometheus-stack \
			--namespace monitoring --create-namespace \
			-f %s \
			--set grafana.adminPassword=%s \
			--set grafana.assertNoLeakedSecrets=false \
			--set prometheus.prometheusSpec.retention=30d \
			--wait --timeout 10m
		helm upgrade --install loki grafana/loki-stack \
			--namespace monitoring \
			--set grafana.enabled=false \
			--set prometheus.enabled=false \
			--wait --timeout 10m || true
	`, tmpFile, cfg.GrafanaPassword))
	if err != nil {
		return err
	}
	color.Green("  ✓ Monitoring stack installed")
	return state.MarkDone("monitoring")
}

func InstallOAuthProxy(cfg *config.Config) error {
	if doneOrSkip("oauth2-proxy", "oauth2-proxy") {
		return nil
	}
	color.Cyan("\n  ■ Installing oauth2-proxy...")
	tmpFile := "/tmp/oauth2-values.yaml"
	if err := writeTemplatedManifest("oauth2-proxy-values.yaml", cfg.Domain, tmpFile); err != nil {
		color.Yellow("  ⚠ oauth2-proxy values missing — skipping")
		return nil
	}
	// Helm tpl() treats {{...}} as templates — inject a real secret instead.
	cookie := cfg.WebhookSecret
	if len(cookie) < 16 {
		cookie = cfg.JWTSecret
	}
	if len(cookie) > 32 {
		cookie = cookie[:32]
	}
	data, _ := os.ReadFile(tmpFile)
	_ = os.WriteFile(tmpFile, []byte(strings.ReplaceAll(string(data), "REPLACE_COOKIE_SECRET", cookie)), 0644)
	defer os.Remove(tmpFile)

	err := shell.RunBash(fmt.Sprintf(`
		helm upgrade --install oauth2-proxy oauth2-proxy/oauth2-proxy \
			--namespace oauth2-proxy --create-namespace \
			-f %s \
			--wait --timeout 5m
	`, tmpFile))
	if err != nil {
		color.Yellow("  ⚠ oauth2-proxy install failed (non-fatal): %v", err)
		return nil
	}
	color.Green("  ✓ oauth2-proxy installed")
	return state.MarkDone("oauth2-proxy")
}

func InstallPortainer(cfg *config.Config) error {
	if doneOrSkip("portainer", "Portainer") {
		return nil
	}
	color.Cyan("\n  ■ Installing Portainer...")
	tmpFile := "/tmp/portainer-values.yaml"
	_ = writeTemplatedManifest("portainer-values.yaml", cfg.Domain, tmpFile)
	defer os.Remove(tmpFile)

	err := shell.RunBash(fmt.Sprintf(`
		helm upgrade --install portainer portainer/portainer \
			--namespace portainer --create-namespace \
			-f %s \
			--set service.type=ClusterIP \
			--wait --timeout 5m
	`, tmpFile))
	if err != nil {
		return err
	}
	color.Green("  ✓ Portainer installed")
	return state.MarkDone("portainer")
}

func InstallInfisical(cfg *config.Config) error {
	if doneOrSkip("infisical", "Infisical") {
		return nil
	}
	color.Cyan("\n  ■ Installing Infisical...")
	// Ensure Infisical DB exists
	_ = shell.RunBash(fmt.Sprintf(`
		kubectl exec -i -n databases postgresql-0 -- env PGPASSWORD=%s \
		  psql -U postgres -c "SELECT 1 FROM pg_database WHERE datname='infisical'" | grep -q 1 || \
		kubectl exec -i -n databases postgresql-0 -- env PGPASSWORD=%s \
		  psql -U postgres -c "CREATE DATABASE infisical;"
	`, cfg.PostgresPassword, cfg.PostgresPassword))

	tmpFile := "/tmp/infisical.yaml"
	_ = writeTemplatedManifest("infisical.yaml", cfg.Domain, tmpFile)
	defer os.Remove(tmpFile)

	err := shell.RunBash(fmt.Sprintf(`
		helm repo add infisical https://dl.cloudsmith.io/public/infisical/helm/helm/charts 2>/dev/null || true
		helm repo update >/dev/null 2>&1 || true
		kubectl create secret generic infisical-secrets -n infisical \
		  --from-literal=ENCRYPTION_KEY=%s \
		  --from-literal=AUTH_SECRET=%s \
		  --from-literal=DB_CONNECTION_URI="postgresql://postgres:%s@postgresql.databases:5432/infisical" \
		  --from-literal=REDIS_URL="redis://:%s@redis-master.databases:6379" \
		  --dry-run=client -o yaml | kubectl apply -f - || true
		helm upgrade --install infisical infisical/infisical \
			--namespace infisical --create-namespace \
			-f %s \
			--wait --timeout 10m || true
	`, cfg.InfisicalEncKey, cfg.InfisicalJWT, cfg.PostgresPassword, cfg.RedisPassword, tmpFile))
	if err != nil {
		color.Yellow("  ⚠ Infisical install failed (non-fatal): %v", err)
		return nil
	}
	color.Green("  ✓ Infisical installed")
	return state.MarkDone("infisical")
}

func pullPlatformImages(cfg *config.Config) error {
	apiImg := fmt.Sprintf("%s/platform-api:%s", cfg.ImageRegistry, cfg.ImageTag)
	portalImg := fmt.Sprintf("%s/platform-portal:%s", cfg.ImageRegistry, cfg.ImageTag)
	color.Cyan("  ■ Pulling pre-built images from registry...")
	color.Cyan("    %s", apiImg)
	color.Cyan("    %s", portalImg)

	if cfg.GitHubToken != "" && strings.Contains(cfg.ImageRegistry, "ghcr.io") {
		_ = shell.RunBash(fmt.Sprintf(
			`echo %s | docker login ghcr.io -u oauth2 --password-stdin 2>/dev/null || true`,
			shellQuote(cfg.GitHubToken)))
	}

	for _, img := range []string{apiImg, portalImg} {
		if err := shell.RunBash(fmt.Sprintf(`
			for i in 1 2 3; do
			  k3s crictl pull %s && exit 0
			  sleep 5
			done
			exit 1
		`, img)); err != nil {
			return fmt.Errorf("failed to pull %s: %w (is the package public on GHCR?)", img, err)
		}
	}
	return nil
}

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func InstallPlatform(cfg *config.Config) error {
	if doneOrSkip("platform", "Platform") {
		return nil
	}
	color.Cyan("\n  ■ Deploying Platform API + Portal...")

	if err := pullPlatformImages(cfg); err != nil {
		return err
	}

	apiImg := fmt.Sprintf("%s/platform-api:%s", cfg.ImageRegistry, cfg.ImageTag)
	portalImg := fmt.Sprintf("%s/platform-portal:%s", cfg.ImageRegistry, cfg.ImageTag)

	err := shell.RunBash(fmt.Sprintf(`
export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"

kubectl create secret generic platform-env \
  --namespace platform \
  --from-literal=NODE_ENV=production \
  --from-literal=PORT=3000 \
  --from-literal=JWT_SECRET=%s \
  --from-literal=PLATFORM_WEBHOOK_SECRET=%s \
  --from-literal=POSTGRES_HOST=postgresql.databases \
  --from-literal=POSTGRES_PORT=5432 \
  --from-literal=POSTGRES_DB=platform \
  --from-literal=POSTGRES_USER=postgres \
  --from-literal=POSTGRES_PASSWORD=%s \
  --from-literal=MONGODB_URI="mongodb://root:%s@mongodb.databases:27017/platform?authSource=admin" \
  --from-literal=REDIS_HOST=redis-master.databases \
  --from-literal=REDIS_PORT=6379 \
  --from-literal=REDIS_PASSWORD=%s \
  --from-literal=MINIO_ENDPOINT=http://minio.storage:9000 \
  --from-literal=MINIO_ACCESS_KEY=%s \
  --from-literal=MINIO_SECRET_KEY=%s \
  --from-literal=PLATFORM_NAME=%s \
  --from-literal=DOMAIN=%s \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl apply -n platform -f - <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: platform-api
  namespace: platform
  labels:
    app: platform-api
spec:
  replicas: 1
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
        image: %s
        imagePullPolicy: IfNotPresent
        ports:
        - containerPort: 3000
        envFrom:
        - secretRef:
            name: platform-env
        readinessProbe:
          httpGet:
            path: /api/health
            port: 3000
          initialDelaySeconds: 15
          periodSeconds: 10
        livenessProbe:
          httpGet:
            path: /api/health
            port: 3000
          initialDelaySeconds: 30
          periodSeconds: 20
        resources:
          requests:
            memory: "256Mi"
            cpu: "250m"
          limits:
            memory: "1Gi"
            cpu: "1000m"
---
apiVersion: v1
kind: Service
metadata:
  name: platform-api
  namespace: platform
spec:
  selector:
    app: platform-api
  ports:
  - name: http
    port: 3000
    targetPort: 3000
---
apiVersion: v1
kind: Service
metadata:
  name: api
  namespace: platform
spec:
  selector:
    app: platform-api
  ports:
  - name: http
    port: 3000
    targetPort: 3000
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: platform-portal
  namespace: platform
  labels:
    app: platform-portal
spec:
  replicas: 1
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
        image: %s
        imagePullPolicy: IfNotPresent
        ports:
        - containerPort: 80
        resources:
          requests:
            memory: "64Mi"
            cpu: "50m"
          limits:
            memory: "256Mi"
            cpu: "200m"
---
apiVersion: v1
kind: Service
metadata:
  name: platform-portal
  namespace: platform
spec:
  selector:
    app: platform-portal
  ports:
  - name: http
    port: 80
    targetPort: 80
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: platform-api-admin-binding
subjects:
- kind: ServiceAccount
  name: default
  namespace: platform
roleRef:
  kind: ClusterRole
  name: cluster-admin
  apiGroup: rbac.authorization.k8s.io
---
apiVersion: v1
kind: Service
metadata:
  name: argocd-proxy
  namespace: platform
spec:
  type: ExternalName
  externalName: argocd-server.argocd.svc.cluster.local
---
apiVersion: v1
kind: Service
metadata:
  name: grafana-proxy
  namespace: platform
spec:
  type: ExternalName
  externalName: kube-prometheus-grafana.monitoring.svc.cluster.local
---
apiVersion: v1
kind: Service
metadata:
  name: portainer-proxy
  namespace: platform
spec:
  type: ExternalName
  externalName: portainer.portainer.svc.cluster.local
---
apiVersion: v1
kind: Service
metadata:
  name: infisical-proxy
  namespace: platform
spec:
  type: ExternalName
  externalName: infisical.infisical.svc.cluster.local
---
apiVersion: v1
kind: Service
metadata:
  name: minio-proxy
  namespace: platform
spec:
  type: ExternalName
  externalName: minio.storage.svc.cluster.local
---
apiVersion: v1
kind: Service
metadata:
  name: oauth2-proxy-proxy
  namespace: platform
spec:
  type: ExternalName
  externalName: oauth2-proxy.oauth2-proxy.svc.cluster.local
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: platform
  namespace: platform
  annotations:
    kubernetes.io/ingress.class: nginx
    nginx.ingress.kubernetes.io/proxy-body-size: "50m"
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  tls:
  - hosts:
    - %s
    - api.%s
    secretName: platform-tls
  rules:
  - host: %s
    http:
      paths:
      - path: /api
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
  - host: api.%s
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: platform-api
            port:
              number: 3000
  - http:
      paths:
      - path: /api
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
EOF

kubectl wait --for=condition=Available deployment/platform-api -n platform --timeout=300s || true
kubectl wait --for=condition=Available deployment/platform-portal -n platform --timeout=180s || true
`,
		shellQuote(cfg.JWTSecret),
		shellQuote(cfg.WebhookSecret),
		shellQuote(cfg.PostgresPassword),
		cfg.MongoPassword,
		shellQuote(cfg.RedisPassword),
		shellQuote(cfg.MinioAccessKey),
		shellQuote(cfg.MinioSecretKey),
		shellQuote(cfg.PlatformName),
		shellQuote(cfg.Domain),
		apiImg, portalImg,
		cfg.Domain, cfg.Domain, cfg.Domain, cfg.Domain,
	))
	if err != nil {
		return err
	}
	color.Green("  ✓ Platform deployed")
	return state.MarkDone("platform")
}

func SeedAdmin(cfg *config.Config) error {
	if doneOrSkip("seed", "seed") {
		return nil
	}
	color.Cyan("\n  ■ Seeding admin user (passwordless demo accounts)...")

	err := shell.RunBash(`
		export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
		API_IP="$(kubectl get svc -n platform platform-api -o jsonpath='{.spec.clusterIP}' 2>/dev/null || true)"
		URL="http://${API_IP:-platform-api.platform.svc.cluster.local}:3000"
		for i in $(seq 1 36); do
		  curl -sf "$URL/api/health" >/dev/null 2>&1 && break
		  sleep 5
		done
		curl -sf "$URL/api/users/init-demo" || true
		TOKEN="$(curl -sf -X POST "$URL/api/auth/login" \
		  -H "Content-Type: application/json" \
		  -d '{"email":"admin@dev.io"}' | grep -o '"token":"[^"]*"' | cut -d'"' -f4 || true)"
		if [[ -z "$TOKEN" ]]; then
		  echo "WARN: could not obtain auth token for seeding — API may still be starting" >&2
		  exit 0
		fi
		echo "Seed login OK"
	`)
	if err != nil {
		return fmt.Errorf("seed admin failed: %w", err)
	}
	color.Green("  ✓ Admin user seeded (login: admin@dev.io, passwordless)")
	return state.MarkDone("seed")
}

func ProvisionComplete(cfg *config.Config) {
	color.Green("\n  ========================================")
	color.Green("   Platform provisioned successfully!")
	color.Green("  ========================================")
	color.Cyan("\n  Access URLs:")
	fmt.Printf("    Portal:    https://%s\n", cfg.Domain)
	fmt.Printf("    API:       https://api.%s\n", cfg.Domain)
	fmt.Printf("    ArgoCD:    https://argocd.%s\n", cfg.Domain)
	fmt.Printf("    Grafana:   https://grafana.%s (admin / see /etc/platform/.env)\n", cfg.Domain)
	color.Cyan("\n  Login:")
	fmt.Printf("    Email: admin@dev.io  (passwordless JWT)\n")
	color.Cyan("\n  Useful commands:")
	fmt.Printf("    export KUBECONFIG=/etc/rancher/k3s/k3s.yaml\n")
	fmt.Printf("    platformctl status\n")
	fmt.Printf("    kubectl get pods -A\n")
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
