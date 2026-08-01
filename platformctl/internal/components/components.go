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
		{"portainer", "Container management UI (subdomain + Platform SSO)", InstallPortainer},
		{"infisical", "Secret management", InstallInfisical},
		{"platform", "Platform API + Portal", InstallPlatform},
		{"routing", "Ingress: ArgoCD /argocd, Grafana /grafana, Portainer subdomain+SSO", InstallRouting},
		{"auto-update", "GHCR auto-update policy (Image Updater + CronJob)", InstallAutoUpdate},
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
	vals = strings.ReplaceAll(vals, "{{BASEHREF}}", "/argocd")
	vals = strings.ReplaceAll(vals, "{{ARGOCD_URL}}", "https://"+domain+"/argocd")
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
	// allowSnippetAnnotations is required so portal iframes can hide
	// X-Frame-Options / CSP from ArgoCD/Grafana/Portainer backends.
	err := shell.RunBash(`
		helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
			--namespace ingress-nginx --create-namespace \
			--set controller.service.type=LoadBalancer \
			--set controller.publishService.enabled=true \
			--set controller.allowSnippetAnnotations=true \
			--set controller.config.annotations-risk-level=Critical \
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
	// Always re-apply values so /argocd subpath stays correct.
	color.Cyan("\n  ■ Installing ArgoCD (path /argocd)...")
	tmpFile := "/tmp/argocd-values.yaml"
	if err := writeTemplatedManifest("argocd-values.yaml", cfg.Domain, tmpFile); err != nil {
		return err
	}
	defer os.Remove(tmpFile)

	err := shell.RunBash(fmt.Sprintf(`
		set -euo pipefail
		export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
		helm repo add argo https://argoproj.github.io/argo-helm 2>/dev/null || true
		helm repo update argo >/dev/null 2>&1 || true
		kubectl create namespace argocd --dry-run=client -o yaml | kubectl apply -f -

		# Modern argo-cd charts keep CRDs under templates/ — helm show crds is empty.
		# Apply Application + AppProject CRDs with server-side apply to avoid the
		# client-side last-applied-configuration 262144-byte limit. Skip ApplicationSet
		# (huge + unused; values disable the controller).
		CHART_DIR=$(mktemp -d)
		helm pull argo/argo-cd --untar -d "$CHART_DIR"
		for crd in crd-application.yaml crd-appproject.yaml; do
		  helm template argocd "$CHART_DIR/argo-cd" \
		    --set crds.install=true \
		    --show-only "templates/crds/${crd}" \
		    | kubectl apply --server-side --force-conflicts -f -
		done
		rm -rf "$CHART_DIR"

		helm upgrade --install argocd argo/argo-cd \
			--namespace argocd \
			-f %s \
			--set crds.install=false \
			--take-ownership \
			--wait --timeout 10m

		# Hard-guarantee subpath settings
		kubectl -n argocd create configmap argocd-cmd-params-cm \
		  --from-literal=server.rootpath=/argocd \
		  --from-literal=server.basehref=/argocd \
		  --from-literal=server.insecure=true \
		  --dry-run=client -o yaml | kubectl apply -f -
		kubectl -n argocd patch configmap argocd-cm --type merge -p '{"data":{"url":"https://%s/argocd","server.basehref":"/argocd","server.rootpath":"/argocd"}}' || true
		kubectl -n argocd patch deployment argocd-server --type=json -p '[
		  {"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--insecure"},
		  {"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--rootpath=/argocd"},
		  {"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--basehref=/argocd"}
		]' 2>/dev/null || true
		kubectl rollout restart deployment argocd-server -n argocd || true
		kubectl rollout status deployment argocd-server -n argocd --timeout=180s || true
	`, tmpFile, cfg.Domain))
	if err != nil {
		return err
	}
	color.Green("  ✓ ArgoCD installed (/argocd subpath)")
	_ = state.MarkDone("argocd")
	return nil
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
	// Always re-apply — cookie-secret length must be exactly 16 or 32 bytes.
	color.Cyan("\n  ■ Installing oauth2-proxy...")
	tmpFile := "/tmp/oauth2-values.yaml"
	if err := writeTemplatedManifest("oauth2-proxy-values.yaml", cfg.Domain, tmpFile); err != nil {
		color.Yellow("  ⚠ oauth2-proxy values missing — skipping")
		return nil
	}
	// oauth2-proxy requires cookie secret of exactly 16 or 32 bytes.
	cookie := cfg.WebhookSecret
	if len(cookie) < 16 {
		cookie = cfg.JWTSecret
	}
	if len(cookie) < 16 {
		cookie = "platform-oauth2-cookie" // 22 chars — pad below
	}
	for len(cookie) < 16 {
		cookie += "0"
	}
	if len(cookie) > 16 && len(cookie) < 32 {
		cookie = cookie[:16]
	}
	if len(cookie) > 32 {
		cookie = cookie[:32]
	}
	data, _ := os.ReadFile(tmpFile)
	_ = os.WriteFile(tmpFile, []byte(strings.ReplaceAll(string(data), "REPLACE_COOKIE_SECRET", cookie)), 0644)
	defer os.Remove(tmpFile)

	err := shell.RunBash(fmt.Sprintf(`
		set -euo pipefail
		export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
		helm repo add oauth2-proxy https://oauth2-proxy.github.io/manifests 2>/dev/null || true
		helm repo update oauth2-proxy >/dev/null 2>&1 || true
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
	// Guarantees on every install/reinstall:
	//  1. Admin is pre-seeded (no "create administrator" wizard)
	//  2. Platform OAuth/SSO is enabled (SSO button on login page)
	//  3. Portainer is only reachable on portainer.<domain> (path /portainer redirects)
	color.Cyan("\n  ■ Installing Portainer...")
	pass := cfg.PortainerPassword
	if pass == "" {
		pass = cfg.AdminPassword
	}
	if len(pass) < 12 {
		return fmt.Errorf("Portainer admin password must be at least 12 characters (set PORTAINER_ADMIN_PASSWORD or ADMIN_PASSWORD)")
	}
	if cfg.Domain == "" {
		return fmt.Errorf("DOMAIN is empty — required for Portainer SSO redirect URI")
	}
	tmpFile := "/tmp/portainer-values.yaml"
	_ = writeTemplatedManifest("portainer-values.yaml", cfg.Domain, tmpFile)
	defer os.Remove(tmpFile)

	if err := shell.RunBash(fmt.Sprintf(`
		set -euo pipefail
		export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
		kubectl create namespace portainer --dry-run=client -o yaml | kubectl apply -f -
		kubectl -n portainer create secret generic portainer-admin-password \
		  --from-literal=password=%s \
		  --dry-run=client -o yaml | kubectl apply -f -
		helm upgrade --install portainer portainer/portainer \
			--namespace portainer --create-namespace \
			-f %s \
			--set service.type=ClusterIP \
			--set ingress.enabled=false \
			--set adminPassword.existingSecret=portainer-admin-password \
			--set 'feature.flags[0]=--no-setup-token' \
			--wait --timeout 5m
		kubectl rollout status deploy/portainer -n portainer --timeout=180s
	`, shellQuote(pass), tmpFile)); err != nil {
		return err
	}

	if err := ensurePortainerAdminAndSSO(cfg, pass); err != nil {
		return err
	}
	color.Green("  ✓ Portainer installed (https://portainer.%s — Platform SSO)", cfg.Domain)
	_ = state.MarkDone("portainer")
	return nil
}

// ensurePortainerAdminAndSSO logs in (resetting the PVC once if admin seed failed)
// and configures Platform OAuth so the SSO button always appears.
func ensurePortainerAdminAndSSO(cfg *config.Config, pass string) error {
	oauthSecret := cfg.WebhookSecret
	if oauthSecret == "" {
		oauthSecret = cfg.JWTSecret
	}
	if len(oauthSecret) < 8 {
		oauthSecret = "portainer-oauth-secret"
	}
	domain := cfg.Domain
	authBody := shellQuote(fmt.Sprintf(`{"username":"admin","password":%q}`, pass))
	settingsBody := shellQuote(fmt.Sprintf(`{
  "AuthenticationMethod": 3,
  "OAuthSettings": {
    "ClientID": "portainer",
    "ClientSecret": %q,
    "AccessTokenURI": "https://%s/api/oauth/token",
    "AuthorizationURI": "https://%s/api/oauth/authorize",
    "ResourceURI": "https://%s/api/oauth/userinfo",
    "RedirectURI": "https://portainer.%s/",
    "UserIdentifier": "email",
    "Scopes": "openid profile email groups",
    "OAuthAutoCreateUsers": true,
    "DefaultTeamID": 0,
    "SSO": true,
    "LogoutURI": "",
    "AuthStyle": 1
  }
}`, oauthSecret, domain, domain, domain, domain))

	return shell.RunBash(fmt.Sprintf(`
set -euo pipefail
export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"

portainer_base() {
  local ip
  ip="$(kubectl -n portainer get svc portainer -o jsonpath='{.spec.clusterIP}' 2>/dev/null || true)"
  if [[ -n "$ip" ]]; then
    echo "http://${ip}:9000"
    return
  fi
  echo "https://portainer.%s"
}

wait_ready() {
  local base="$1"
  local i
  for i in $(seq 1 36); do
    curl -skf "$base/api/system/status" >/dev/null 2>&1 && return 0
    sleep 5
  done
  return 1
}

login() {
  local base="$1"
  curl -sk -X POST "$base/api/auth" \
    -H 'Content-Type: application/json' \
    -d %s | grep -o '"jwt":"[^"]*"' | cut -d'"' -f4 || true
}

configure_sso() {
  local base="$1" token="$2"
  curl -sk -X PUT "$base/api/settings" \
    -H "Authorization: Bearer $token" \
    -H 'Content-Type: application/json' \
    -d %s >/dev/null
  # Verify SSO is actually on
  local method
  method="$(curl -sk "$base/api/settings/public" | grep -o '"AuthenticationMethod":[0-9]*' | head -1 | cut -d: -f2 || true)"
  if [[ "$method" != "3" ]]; then
    echo "Portainer AuthenticationMethod=$method (want 3=OAuth)" >&2
    return 1
  fi
  echo "Portainer SSO OK (AuthenticationMethod=3) via $base"
}

BASE="$(portainer_base)"
wait_ready "$BASE" || { echo "Portainer API not ready at $BASE" >&2; exit 1; }

TOKEN="$(login "$BASE")"
if [[ -z "$TOKEN" ]]; then
  echo "Admin login failed — resetting Portainer volume so --admin-password-file can seed admin"
  kubectl -n portainer delete deploy portainer --ignore-not-found
  kubectl -n portainer delete pvc portainer --ignore-not-found
  sleep 3
  helm upgrade --install portainer portainer/portainer \
    --namespace portainer --create-namespace \
    --set service.type=ClusterIP \
    --set ingress.enabled=false \
    --set adminPassword.existingSecret=portainer-admin-password \
    --set 'feature.flags[0]=--no-setup-token' \
    --wait --timeout 5m
  kubectl rollout status deploy/portainer -n portainer --timeout=180s
  BASE="$(portainer_base)"
  wait_ready "$BASE" || { echo "Portainer API not ready after reset" >&2; exit 1; }
  TOKEN="$(login "$BASE")"
  if [[ -z "$TOKEN" ]]; then
    echo "Portainer admin login still failing after PVC reset" >&2
    exit 1
  fi
fi

configure_sso "$BASE" "$TOKEN"
`, domain, authBody, settingsBody))
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
  --from-literal=ADMIN_EMAIL=%s \
  --from-literal=ADMIN_PASSWORD=%s \
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
		shellQuote(cfg.AdminEmail),
		shellQuote(cfg.AdminPassword),
		apiImg, portalImg,
	))
	if err != nil {
		return err
	}
	if err := ApplyServiceRouting(cfg); err != nil {
		return err
	}
	color.Green("  ✓ Platform deployed")
	return state.MarkDone("platform")
}

// InstallRouting re-applies ingress so ArgoCD (full-page /argocd), Grafana
// (iframe /grafana), and Portainer (subdomain + /portainer redirect) stay correct.
// Also re-applies Portainer SSO in case Portainer was installed before ingress existed.
func InstallRouting(cfg *config.Config) error {
	color.Cyan("\n  ■ Fixing service routing (ArgoCD / Grafana / Portainer)...")
	if err := ApplyServiceRouting(cfg); err != nil {
		return err
	}
	// Re-assert ArgoCD subpath (idempotent)
	if err := InstallArgoCD(cfg); err != nil {
		color.Yellow("  ⚠ ArgoCD re-apply: %v", err)
	}
	// Grafana embedding + subpath
	_ = shell.RunBash(fmt.Sprintf(`
		export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
		helm upgrade kube-prometheus prometheus-community/kube-prometheus-stack \
		  --namespace monitoring \
		  --reuse-values \
		  --set grafana.grafana\.ini.server.root_url="https://%s/grafana/" \
		  --set grafana.grafana\.ini.server.serve_from_sub_path=true \
		  --set grafana.grafana\.ini.security.allow_embedding=true \
		  --set grafana.grafana\.ini.security.cookie_samesite=none \
		  --set grafana.grafana\.ini.security.cookie_secure=true \
		  --timeout 10m || true
		kubectl rollout restart deploy -n monitoring -l app.kubernetes.io/name=grafana || true
	`, cfg.Domain))
	// Portainer SSO must run after ingress/DNS exist; idempotent re-apply
	if cfg.InstallPortainer {
		pass := cfg.PortainerPassword
		if pass == "" {
			pass = cfg.AdminPassword
		}
		if len(pass) >= 12 {
			if err := ensurePortainerAdminAndSSO(cfg, pass); err != nil {
				return fmt.Errorf("portainer SSO: %w", err)
			}
		}
	}
	color.Green("  ✓ Service routing fixed")
	_ = state.Clear("routing")
	return state.MarkDone("routing")
}

// ApplyServiceRouting installs ExternalName proxies + platform Ingress.
// ArgoCD: full-page at /argocd (with base-href sub_filter).
// Grafana: iframe at /grafana.
// Portainer: subdomain only — /portainer permanently redirects (no shared-host /api clash).
func ApplyServiceRouting(cfg *config.Config) error {
	d := cfg.Domain
	if d == "" {
		return fmt.Errorf("DOMAIN is empty — set DOMAIN or ensure /etc/platform/.env exists")
	}
	// Use __DOMAIN__ + ReplaceAll (not fmt.Sprintf) so nginx /$2 rewrite tokens
	// and quoted heredocs are not mangled by bash set -u or fmt verbs.
	script := strings.ReplaceAll(`
set -euo pipefail
export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"

# Grafana/Portainer iframes need X-Frame-Options stripped; ArgoCD needs base-href fix.
# ingress-nginx 1.12+ blocks snippet annotations unless explicitly allowed.
helm upgrade ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx \
  --reuse-values \
  --set controller.allowSnippetAnnotations=true \
  --set controller.config.annotations-risk-level=Critical \
  --timeout 5m >/dev/null || \
kubectl -n ingress-nginx patch configmap ingress-nginx-controller --type merge \
  -p '{"data":{"allow-snippet-annotations":"true","annotations-risk-level":"Critical"}}' || true

kubectl apply -n platform -f - <<'EOF'
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
  externalName: minio-console.storage.svc.cluster.local
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
    nginx.ingress.kubernetes.io/configuration-snippet: |
      proxy_hide_header X-Frame-Options;
      proxy_hide_header Content-Security-Policy;
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - __DOMAIN__
    - api.__DOMAIN__
    - argocd.__DOMAIN__
    - grafana.__DOMAIN__
    - portainer.__DOMAIN__
    secretName: platform-tls
  rules:
  - host: __DOMAIN__
    http:
      paths:
      - path: /api
        pathType: Prefix
        backend:
          service:
            name: platform-api
            port:
              number: 3000
      - path: /grafana
        pathType: Prefix
        backend:
          service:
            name: grafana-proxy
            port:
              number: 80
      - path: /minio
        pathType: Prefix
        backend:
          service:
            name: minio-proxy
            port:
              number: 9090
      - path: /oauth2
        pathType: Prefix
        backend:
          service:
            name: oauth2-proxy-proxy
            port:
              number: 4180
      - path: /
        pathType: Prefix
        backend:
          service:
            name: platform-portal
            port:
              number: 80
  - host: api.__DOMAIN__
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: platform-api
            port:
              number: 3000
  - host: argocd.__DOMAIN__
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: argocd-proxy
            port:
              number: 80
  - host: grafana.__DOMAIN__
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: grafana-proxy
            port:
              number: 80
  - host: portainer.__DOMAIN__
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: portainer-proxy
            port:
              number: 9000
EOF

# Argo CD is full-page at /argocd/. 3.x keeps <base href="/"> even with --basehref;
# fix assets via sub_filter so the UI loads under the subpath.
kubectl apply -n platform -f - <<'EOF'
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: platform-argocd
  namespace: platform
  annotations:
    kubernetes.io/ingress.class: nginx
    nginx.ingress.kubernetes.io/backend-protocol: HTTP
    nginx.ingress.kubernetes.io/proxy-body-size: "50m"
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/configuration-snippet: |
      proxy_set_header Accept-Encoding "";
      sub_filter '<base href="/">' '<base href="/argocd/">';
      sub_filter_once on;
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - __DOMAIN__
    secretName: platform-tls
  rules:
  - host: __DOMAIN__
    http:
      paths:
      - path: /argocd
        pathType: Prefix
        backend:
          service:
            name: argocd-proxy
            port:
              number: 80
EOF

# Portainer has no subpath support and its /api + static assets collide with the
# portal on the same host. Serve it only on portainer.__DOMAIN__ and redirect
# legacy /portainer links there.
kubectl apply -n platform -f - <<'EOF'
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: platform-portainer
  namespace: platform
  annotations:
    kubernetes.io/ingress.class: nginx
    nginx.ingress.kubernetes.io/permanent-redirect: https://portainer.__DOMAIN__/
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - __DOMAIN__
    secretName: platform-tls
  rules:
  - host: __DOMAIN__
    http:
      paths:
      - path: /portainer
        pathType: Prefix
        backend:
          service:
            name: platform-portal
            port:
              number: 80
EOF

kubectl delete ingress argocd-ingress portainer-ingress -n platform --ignore-not-found
`, "__DOMAIN__", d)
	return shell.RunBash(script)
}

func SeedAdmin(cfg *config.Config) error {
	if doneOrSkip("seed", "seed") {
		return nil
	}
	color.Cyan("\n  ■ Seeding admin user (email + password)...")

	email := cfg.AdminEmail
	if email == "" {
		email = "admin@pratyushes.dev"
	}
	pass := cfg.AdminPassword
	err := shell.RunBash(fmt.Sprintf(`
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
		  -d %s | grep -o '"token":"[^"]*"' | cut -d'"' -f4 || true)"
		if [[ -z "$TOKEN" ]]; then
		  echo "WARN: could not obtain auth token for seeding — check ADMIN_PASSWORD and API logs" >&2
		  exit 0
		fi
		echo "Seed login OK"
	`, shellQuote(fmt.Sprintf(`{"email":%q,"password":%q}`, email, pass))))
	if err != nil {
		return fmt.Errorf("seed admin failed: %w", err)
	}
	color.Green("  ✓ Admin user seeded (email + password)")
	return state.MarkDone("seed")
}

func ProvisionComplete(cfg *config.Config) {
	color.Green("\n  ========================================")
	color.Green("   Platform provisioned successfully!")
	color.Green("  ========================================")
	color.Cyan("\n  Access URLs:")
	fmt.Printf("    Portal:    https://%s\n", cfg.Domain)
	fmt.Printf("    API:       https://api.%s\n", cfg.Domain)
	fmt.Printf("    ArgoCD:    https://%s/argocd/\n", cfg.Domain)
	fmt.Printf("    Grafana:   https://%s/grafana/ (admin / see /etc/platform/.env)\n", cfg.Domain)
	fmt.Printf("    Portainer: https://portainer.%s/  (Platform SSO; admin fallback in PORTAINER_ADMIN_PASSWORD)\n", cfg.Domain)
	color.Cyan("\n  Login (password required):")
	fmt.Printf("    Email:    %s\n", cfg.AdminEmail)
	fmt.Printf("    Password: %s\n", cfg.AdminPassword)
	fmt.Printf("    (also stored in /etc/platform/.env as ADMIN_PASSWORD)\n")
	color.Cyan("\n  Docs / landing site:")
	fmt.Printf("    https://platform.pratyushes.dev\n")
	color.Cyan("\n  Auto-update:")
	if cfg.AutoUpdate {
		fmt.Printf("    Enabled (CronJob every 15m + Argo Image Updater). Manual: platformctl update\n")
	} else {
		fmt.Printf("    Disabled. Enable with AUTO_UPDATE=true or: platformctl install auto-update\n")
	}
	color.Cyan("\n  Useful commands:")
	fmt.Printf("    export KUBECONFIG=/etc/rancher/k3s/k3s.yaml\n")
	fmt.Printf("    platformctl status\n")
	fmt.Printf("    platformctl update\n")
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

// UpdateImages pulls the configured GHCR tags and rolls the Platform deployments.
func UpdateImages(cfg *config.Config) error {
	color.Cyan("\n  ■ Updating Platform images (%s)...", cfg.ImageTag)
	apiImg := fmt.Sprintf("%s/platform-api:%s", cfg.ImageRegistry, cfg.ImageTag)
	portalImg := fmt.Sprintf("%s/platform-portal:%s", cfg.ImageRegistry, cfg.ImageTag)

	if err := pullPlatformImages(cfg); err != nil {
		return err
	}
	err := shell.RunBash(fmt.Sprintf(`
		export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
		kubectl set image -n platform deploy/platform-api api=%s
		kubectl set image -n platform deploy/platform-portal portal=%s
		kubectl patch deploy platform-api -n platform -p '{"spec":{"template":{"spec":{"containers":[{"name":"api","imagePullPolicy":"Always"}]}}}}' || true
		kubectl patch deploy platform-portal -n platform -p '{"spec":{"template":{"spec":{"containers":[{"name":"portal","imagePullPolicy":"Always"}]}}}}' || true
		kubectl rollout status -n platform deploy/platform-api --timeout=300s
		kubectl rollout status -n platform deploy/platform-portal --timeout=180s
	`, apiImg, portalImg))
	if err != nil {
		return err
	}
	color.Green("  ✓ Images updated to %s / %s", apiImg, portalImg)
	return nil
}

// InstallAutoUpdate installs Argo CD Image Updater + a CronJob so every env
// keeps platform-api / platform-portal on the newest published GHCR tags.
func InstallAutoUpdate(cfg *config.Config) error {
	if !cfg.AutoUpdate {
		color.Yellow("  ○ AUTO_UPDATE=false — skipping auto-update policy")
		return nil
	}
	if doneOrSkip("auto-update", "auto-update") {
		return nil
	}
	color.Cyan("\n  ■ Configuring auto-update policy (GHCR → all envs)...")

	apiImg := fmt.Sprintf("%s/platform-api", cfg.ImageRegistry)
	portalImg := fmt.Sprintf("%s/platform-portal", cfg.ImageRegistry)
	tag := cfg.ImageTag
	if tag == "" {
		tag = "latest"
	}

	script := fmt.Sprintf(`
export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"

# Argo CD Image Updater (watches GHCR, writes new tags into the Application)
helm repo add argo https://argoproj.github.io/argo-helm 2>/dev/null || true
helm repo update >/dev/null 2>&1 || true
helm upgrade --install argocd-image-updater argo/argocd-image-updater \
  --namespace argocd --create-namespace \
  --set config.registries[0].name=ghcr \
  --set config.registries[0].api_url=https://ghcr.io \
  --set config.registries[0].prefix=ghcr.io \
  --set config.registries[0].insecure=false \
  --wait --timeout 5m || true

# Ensure Deployments always pull when the tag moves (e.g. :latest digest change)
kubectl patch deploy platform-api -n platform --type=merge -p '{"spec":{"template":{"spec":{"containers":[{"name":"api","imagePullPolicy":"Always"}]}}}}' || true
kubectl patch deploy platform-portal -n platform --type=merge -p '{"spec":{"template":{"spec":{"containers":[{"name":"portal","imagePullPolicy":"Always"}]}}}}' || true

# CronJob fallback: every 15 minutes pull + roll to the configured tag.
# Works even if Image Updater / Argo Application sync is unavailable.
kubectl apply -f - <<EOF
apiVersion: v1
kind: ServiceAccount
metadata:
  name: platform-auto-update
  namespace: platform
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: platform-auto-update
  namespace: platform
rules:
  - apiGroups: ["apps"]
    resources: ["deployments"]
    verbs: ["get", "list", "patch", "update"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: platform-auto-update
  namespace: platform
subjects:
  - kind: ServiceAccount
    name: platform-auto-update
    namespace: platform
roleRef:
  kind: Role
  name: platform-auto-update
  apiGroup: rbac.authorization.k8s.io
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: platform-auto-update
  namespace: platform
spec:
  schedule: "*/15 * * * *"
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 1
  failedJobsHistoryLimit: 2
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: platform-auto-update
          restartPolicy: OnFailure
          containers:
            - name: update
              image: bitnami/kubectl:latest
              imagePullPolicy: IfNotPresent
              command:
                - /bin/bash
                - -c
                - |
                  set -euo pipefail
                  API="%s:%s"
                  PORTAL="%s:%s"
                  kubectl set image -n platform deploy/platform-api api="$API"
                  kubectl set image -n platform deploy/platform-portal portal="$PORTAL"
                  echo "auto-update applied $API $PORTAL"
EOF

# Argo Application with Image Updater annotations (optional GitOps path)
kubectl apply -f - <<EOF
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: platform
  namespace: argocd
  annotations:
    argocd-image-updater.argoproj.io/image-list: platform-api=%s,platform-portal=%s
    argocd-image-updater.argoproj.io/platform-api.update-strategy: newest-build
    argocd-image-updater.argoproj.io/platform-portal.update-strategy: newest-build
    argocd-image-updater.argoproj.io/platform-api.force-update: "true"
    argocd-image-updater.argoproj.io/platform-portal.force-update: "true"
    argocd-image-updater.argoproj.io/write-back-method: argocd
spec:
  project: default
  source:
    repoURL: %s
    targetRevision: HEAD
    path: k8s/platform
  destination:
    server: https://kubernetes.default.svc
    namespace: platform
  syncPolicy:
    automated:
      prune: false
      selfHeal: true
EOF
`, apiImg, tag, portalImg, tag, apiImg, portalImg, cfg.RepoURL)

	if err := shell.RunBash(script); err != nil {
		color.Yellow("  ⚠ auto-update setup had errors (non-fatal): %v", err)
		return nil
	}
	color.Green("  ✓ Auto-update enabled (Image Updater + CronJob */15)")
	return state.MarkDone("auto-update")
}
