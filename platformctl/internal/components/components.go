package components

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"

	"github.com/fatih/color"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/manifests"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/shell"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/state"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/versions"
)

// chart returns the pinned chart reference for `helm upgrade --install` /
// `helm template` (a cached local tarball when available).
func chart(name string) string { return versions.Get(name).Ref() }

// helmLockHelper clears stuck Helm release secrets (pending-install/upgrade/rollback)
// so re-provision can continue after an interrupted helm --wait.
const helmLockHelper = `
clear_helm_lock() {
  local release="$1" ns="$2"
  kubectl -n "$ns" get secrets -l "owner=helm,name=${release}" -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.labels.status}{"\n"}{end}' 2>/dev/null \
  | while IFS="$(printf '\t')" read -r name status; do
      case "$status" in
        pending-install|pending-upgrade|pending-rollback)
          echo "Clearing stuck Helm lock: $name ($status)"
          kubectl -n "$ns" delete secret "$name" --ignore-not-found
          ;;
      esac
    done
}
`

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
	// Disable HSTS includeSubDomains so project hosts like
	// {app}.{ip}.sslip.io are not force-HTTPS'd with the default fake cert
	// before their own Let's Encrypt Ingress exists.
	err := shell.RunBash(`
		helm upgrade --install ingress-nginx ` + chart("ingress-nginx") + ` \
			--namespace ingress-nginx --create-namespace \
			--set controller.service.type=LoadBalancer \
			--set controller.publishService.enabled=true \
			--set controller.allowSnippetAnnotations=true \
			--set controller.config.annotations-risk-level=Critical \
			--set controller.config.hsts=true \
			--set controller.config.hsts-include-subdomains=false \
			--set controller.config.hsts-max-age=31536000 \
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
		`helm upgrade --install cert-manager ` + chart("cert-manager") + ` \
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
	err := helmValues("postgresql", "postgresql", "databases", map[string]any{"auth": map[string]string{"postgresPassword": cfg.PostgresPassword, "database": "platform"}}, "--set", "primary.persistence.size=10Gi", "--wait", "--timeout", "10m")
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
	err := helmValues("mongodb", "mongodb", "databases", map[string]any{"auth": map[string]string{"rootPassword": cfg.MongoPassword}}, "--set", "persistence.size=10Gi", "--wait", "--timeout", "10m")
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
	err := helmValues("redis", "redis", "databases", map[string]any{"auth": map[string]string{"password": cfg.RedisPassword}}, "--set", "master.persistence.size=5Gi", "--wait", "--timeout", "10m")
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
	tmpFile, err := temporaryManifest("minio-values.yaml", cfg.Domain)
	if err != nil {
		return err
	}
	defer os.Remove(tmpFile)

	err = helmValues("minio", "minio", "storage", map[string]any{"auth": map[string]string{"rootUser": cfg.MinioAccessKey, "rootPassword": cfg.MinioSecretKey}}, "-f", tmpFile, "--set", "persistence.size=50Gi", "--set", "image.repository=bitnamilegacy/minio", "--set", "console.image.repository=bitnamilegacy/minio-object-browser", "--set", `defaultBuckets=platform-backups\,platform-logs`, "--wait", "--timeout", "10m")
	if err != nil {
		return err
	}
	color.Green("  ✓ MinIO installed")
	return state.MarkDone("minio")
}

func InstallArgoCD(cfg *config.Config) error {
	if state.IsDone("argocd") && argocdLooksHealthy() {
		color.Green("  ✓ ArgoCD already done")
		_ = patchArgoCDSubpath(cfg)
		return nil
	}
	_ = state.MarkInProgress("argocd")
	color.Cyan("\n  ■ Installing ArgoCD (path /argocd)...")
	tmpFile, err := temporaryManifest("argocd-values.yaml", cfg.Domain)
	if err != nil {
		return err
	}
	defer os.Remove(tmpFile)

	err = shell.RunBash(fmt.Sprintf(`
		set -euo pipefail
		export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
		ARGO_CHART="%[2]s"

		reset_argocd() {
		  echo "Resetting ArgoCD for clean Helm install..."
		  helm uninstall argocd -n argocd --wait --timeout 3m 2>/dev/null || true
		  kubectl delete namespace argocd --wait=true --timeout=180s 2>/dev/null || true
		  for i in $(seq 1 90); do
		    kubectl get ns argocd >/dev/null 2>&1 || break
		    sleep 2
		  done
		  if kubectl get ns argocd >/dev/null 2>&1; then
		    echo "Forcing removal of stuck argocd namespace finalizers..."
		    kubectl get ns argocd -o json | python3 -c '
import json,sys
d=json.load(sys.stdin)
d.setdefault("spec",{})["finalizers"]=[]
json.dump(d,sys.stdout)
' | kubectl replace --raw /api/v1/namespaces/argocd/finalize -f - 2>/dev/null || true
		    for i in $(seq 1 30); do
		      kubectl get ns argocd >/dev/null 2>&1 || break
		      sleep 2
		    done
		  fi
		  kubectl get clusterrole,clusterrolebinding -o name 2>/dev/null \
		    | grep -E 'argocd|argo-cd' \
		    | xargs -r kubectl delete --ignore-not-found 2>/dev/null || true
		  kubectl create namespace argocd
		}

		apply_argocd_crds() {
		  # One render of the pinned (usually cached) chart for both CRDs.
		  helm template argocd $ARGO_CHART \
		    --set crds.install=true \
		    --show-only templates/crds/crd-application.yaml \
		    --show-only templates/crds/crd-appproject.yaml \
		    | kubectl apply --server-side --force-conflicts -f -
		}

		helm_install_argocd() {
		  helm upgrade --install argocd $ARGO_CHART \
		    --namespace argocd \
		    --create-namespace \
		    -f %[1]s \
		    --set crds.install=false \
		    --set applicationSet.enabled=false \
		    --set notifications.enabled=false \
		    --set dex.enabled=false \
		    --wait --timeout 10m
		}

		argocd_healthy() {
		  helm status argocd -n argocd >/dev/null 2>&1 \
		    && kubectl -n argocd get deploy argocd-server >/dev/null 2>&1 \
		    && kubectl -n argocd get configmap argocd-cm >/dev/null 2>&1
		}

		if argocd_healthy; then
		  if ! helm_install_argocd; then
		    echo "ArgoCD Helm upgrade failed — self-healing with clean reinstall"
		    reset_argocd
		    apply_argocd_crds
		    helm_install_argocd
		  fi
		elif ! kubectl get ns argocd >/dev/null 2>&1 || [[ -z "$(kubectl -n argocd get all -o name 2>/dev/null)" ]]; then
		  # Fresh server (or empty namespace): nothing to reset.
		  apply_argocd_crds
		  helm_install_argocd
		else
		  reset_argocd
		  apply_argocd_crds
		  helm_install_argocd
		fi

		if ! argocd_healthy; then
		  echo "ArgoCD install finished but argocd-server/argocd-cm missing — retrying clean install" >&2
		  reset_argocd
		  apply_argocd_crds
		  helm_install_argocd
		fi
		argocd_healthy
	`, tmpFile, chart("argo-cd")))
	if err != nil {
		return err
	}
	_ = patchArgoCDSubpath(cfg)
	color.Green("  ✓ ArgoCD installed (/argocd subpath)")
	_ = state.MarkDone("argocd")
	return nil
}

func argocdLooksHealthy() bool {
	out, err := shell.OutputBash(`
		export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
		helm status argocd -n argocd >/dev/null 2>&1 \
		  && kubectl -n argocd get deploy argocd-server >/dev/null 2>&1 \
		  && kubectl -n argocd get configmap argocd-cm >/dev/null 2>&1
	`)
	_ = out
	return err == nil
}

func patchArgoCDSubpath(cfg *config.Config) error {
	if cfg.Domain == "" {
		return nil
	}
	return shell.RunBash(fmt.Sprintf(`
		export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
		kubectl -n argocd create configmap argocd-cmd-params-cm \
		  --from-literal=server.rootpath=/argocd \
		  --from-literal=server.basehref=/argocd \
		  --from-literal=server.insecure=true \
		  --dry-run=client -o yaml | kubectl apply -f - >/dev/null 2>&1 || true
		kubectl -n argocd patch configmap argocd-cm --type merge -p '{"data":{"url":"https://%s/argocd","server.basehref":"/argocd","server.rootpath":"/argocd"}}' >/dev/null 2>&1 || true
	`, cfg.Domain))
}

func InstallMonitoring(cfg *config.Config) error {
	if doneOrSkip("monitoring", "monitoring") {
		return nil
	}
	color.Cyan("\n  ■ Installing monitoring stack...")
	tmpFile, err := temporaryManifest("grafana-values.yaml", cfg.Domain)
	if err != nil {
		return err
	}
	defer os.Remove(tmpFile)

	secretFile, cleanup, err := privateJSON(map[string]any{"grafana": map[string]string{"adminPassword": cfg.GrafanaPassword}})
	if err != nil {
		return err
	}
	defer cleanup()
	err = shell.RunBash(fmt.Sprintf(`
		set -uo pipefail
		# Loki is independent of kube-prometheus-stack: install both concurrently.
		helm upgrade --install loki %[3]s \
			--namespace monitoring --create-namespace \
			--set grafana.enabled=false \
			--set prometheus.enabled=false \
			--wait --timeout 10m > /tmp/platformctl-loki.log 2>&1 &
		loki_pid=$!
		helm upgrade --install kube-prometheus %[4]s \
			--namespace monitoring --create-namespace \
			-f %[1]s \
			-f %[2]s \
			--set grafana.assertNoLeakedSecrets=false \
			--set prometheus.prometheusSpec.retention=30d \
			--wait --timeout 10m
		rc=$?
		wait "$loki_pid" || { echo "WARN: loki install failed (non-fatal):"; tail -20 /tmp/platformctl-loki.log; }
		exit $rc
	`, tmpFile, shellQuote(secretFile), chart("loki-stack"), chart("kube-prometheus-stack")))
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
	_ = state.MarkInProgress("oauth2-proxy")
	color.Cyan("\n  ■ Installing oauth2-proxy...")
	tmpFile, err := temporaryManifest("oauth2-proxy-values.yaml", cfg.Domain)
	if err != nil {
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

	err = shell.RunBash(fmt.Sprintf(`
		set -euo pipefail
		export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
		%s
		clear_helm_lock oauth2-proxy oauth2-proxy
		if ! helm upgrade --install oauth2-proxy %[3]s \
			--namespace oauth2-proxy --create-namespace \
			-f %[2]s \
			--wait --timeout 5m; then
		  echo "oauth2-proxy upgrade failed — clearing lock and retrying"
		  clear_helm_lock oauth2-proxy oauth2-proxy
		  helm upgrade --install oauth2-proxy %[3]s \
			--namespace oauth2-proxy --create-namespace \
			-f %[2]s \
			--wait --timeout 5m
		fi
	`, helmLockHelper, tmpFile, chart("oauth2-proxy")))
	if err != nil {
		color.Yellow("  ⚠ oauth2-proxy install failed (non-fatal): %v", err)
		return nil
	}
	color.Green("  ✓ oauth2-proxy installed")
	return state.MarkDone("oauth2-proxy")
}

func InstallPortainer(cfg *config.Config) error {
	if cfg.ResetPortainer {
		if err := shell.Run("kubectl", "-n", "portainer", "delete", "deployment", "portainer", "--ignore-not-found", "--wait=true"); err != nil {
			return err
		}
		if err := shell.Run("kubectl", "-n", "portainer", "delete", "pvc", "portainer", "--ignore-not-found", "--wait=true"); err != nil {
			return err
		}
		if err := state.Clear("portainer"); err != nil {
			return err
		}
		if err := state.Clear("portainer-sso"); err != nil {
			return err
		}
	}
	if doneOrSkip("portainer", "Portainer") {
		return nil
	}
	_ = state.MarkInProgress("portainer")
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
	tmpFile, err := temporaryManifest("portainer-values.yaml", cfg.Domain)
	if err != nil {
		return err
	}
	defer os.Remove(tmpFile)

	if err := shell.RunBash(`set -euo pipefail; kubectl create namespace portainer --dry-run=client -o yaml | kubectl apply -f -`); err != nil {
		return err
	}
	if err := applySecret("portainer", "portainer-admin-password", map[string]string{"password": pass}); err != nil {
		return err
	}
	if err := shell.RunBash(fmt.Sprintf(`
		set -euo pipefail
		export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
		%[1]s
		kubectl create namespace portainer --dry-run=client -o yaml | kubectl apply -f -
		clear_helm_lock portainer portainer
		helm_install_portainer() {
		  helm upgrade --install portainer %[3]s \
			--namespace portainer --create-namespace \
			-f %[2]s \
			--set service.type=ClusterIP \
			--set ingress.enabled=false \
			--set adminPassword.existingSecret=portainer-admin-password \
			--set 'feature.flags[0]=--no-setup-token' \
			--wait --timeout 5m
		}
		helm_install_portainer
		kubectl rollout status deploy/portainer -n portainer --timeout=180s
	`, helmLockHelper, tmpFile, chart("portainer"))); err != nil {
		return err
	}

	if err := ensurePortainerAdminAndSSO(cfg, pass); err != nil {
		return err
	} else {
		// Lets InstallRouting skip a second SSO pass when this one succeeded.
		_ = state.MarkDone("portainer-sso")
	}
	color.Green("  ✓ Portainer installed (https://portainer.%s — Platform SSO)", cfg.Domain)
	_ = state.MarkDone("portainer")
	return nil
}

// ensurePortainerAdminAndSSO logs in without modifying persistent storage
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
	authFile, authCleanup, err := privateJSON(map[string]string{"username": "admin", "password": pass})
	if err != nil {
		return err
	}
	defer authCleanup()
	authBody := shellQuote("@" + authFile)
	settingsJSON := fmt.Sprintf(`{
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
}`, oauthSecret, domain, domain, domain, domain)
	settingsFile, settingsCleanup, err := privateFile([]byte(settingsJSON))
	if err != nil {
		return err
	}
	defer settingsCleanup()
	settingsBody := shellQuote("@" + settingsFile)

	return shell.RunBash(fmt.Sprintf(`
set -euo pipefail
export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
CURL=(curl -sk --connect-timeout 5 --max-time 20)

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
  for i in $(seq 1 24); do
    "${CURL[@]}" -f "$base/api/system/status" >/dev/null 2>&1 && return 0
    sleep 5
  done
  return 1
}

login() {
  local base="$1"
  "${CURL[@]}" -X POST "$base/api/auth" \
    -H 'Content-Type: application/json' \
    -d %s | grep -o '"jwt":"[^"]*"' | cut -d'"' -f4 || true
}

configure_sso() {
  local base="$1" token="$2"
  "${CURL[@]}" -X PUT "$base/api/settings" \
    -H "Authorization: Bearer $token" \
    -H 'Content-Type: application/json' \
    -d %s >/dev/null
  local method
  method="$("${CURL[@]}" "$base/api/settings/public" | grep -o '"AuthenticationMethod":[0-9]*' | head -1 | cut -d: -f2 || true)"
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
  echo "Portainer admin login failed. Check credentials/connectivity; to wipe Portainer data explicitly run: platformctl install portainer --reset" >&2
  exit 1
fi

configure_sso "$BASE" "$TOKEN"
`, domain, authBody, settingsBody))
}

func InstallInfisical(cfg *config.Config) error {
	if doneOrSkip("infisical", "Infisical") {
		return nil
	}
	color.Cyan("\n  ■ Installing Infisical...")
	// Pass the database password as one argument, never shell source.
	args := []string{"exec", "-i", "-n", "databases", "postgresql-0", "--", "env", "PGPASSWORD=" + cfg.PostgresPassword, "psql", "-w", "-U", "postgres"}
	out, err := shell.Output("kubectl", append(args, "-tAc", "SELECT 1 FROM pg_database WHERE datname='infisical'")...)
	if err != nil {
		return err
	}
	if strings.TrimSpace(out) != "1" {
		if err := shell.Run("kubectl", append(args, "-c", "CREATE DATABASE infisical;")...); err != nil {
			return err
		}
	}

	tmpFile, err := temporaryManifest("infisical.yaml", cfg.Domain)
	if err != nil {
		color.Yellow("  ⚠ Infisical manifest missing (non-fatal): %v", err)
		return nil
	}
	defer os.Remove(tmpFile)

	if err := shell.RunBash(`set -euo pipefail; kubectl create namespace infisical --dry-run=client -o yaml | kubectl apply -f -`); err != nil {
		return err
	}
	if err := applySecret("infisical", "infisical-secrets", map[string]string{
		"ENCRYPTION_KEY": cfg.InfisicalEncKey, "AUTH_SECRET": cfg.InfisicalJWT,
		"DB_CONNECTION_URI": "postgresql://postgres:" + url.QueryEscape(cfg.PostgresPassword) + "@postgresql.databases:5432/infisical",
		"REDIS_URL":         "redis://:" + url.QueryEscape(cfg.RedisPassword) + "@redis-master.databases:6379",
	}); err != nil {
		return err
	}
	err = shell.Run("kubectl", "apply", "-f", tmpFile)
	if err != nil {
		color.Yellow("  ⚠ Infisical install failed (non-fatal): %v", err)
		return nil
	}
	color.Green("  ✓ Infisical installed")
	return state.MarkDone("infisical")
}

// pullPlatformImages pulls API + portal in parallel. With force=false images
// already in containerd are skipped (provision); force=true re-pulls so a moved
// tag such as :latest is refreshed (update).
func pullPlatformImages(cfg *config.Config, force bool) error {
	apiImg := fmt.Sprintf("%s/platform-api:%s", cfg.ImageRegistry, cfg.ImageTag)
	portalImg := fmt.Sprintf("%s/platform-portal:%s", cfg.ImageRegistry, cfg.ImageTag)
	color.Cyan("  ■ Pulling pre-built images from registry...")
	color.Cyan("    %s", apiImg)
	color.Cyan("    %s", portalImg)

	// GHCR credentials (if any) come from /etc/rancher/k3s/registries.yaml,
	// written before k3s starts — that is what containerd/crictl read.
	imgs := []string{apiImg, portalImg}
	errs := make([]error, len(imgs))
	var wg sync.WaitGroup
	for i, img := range imgs {
		wg.Add(1)
		go func(i int, img string) {
			defer wg.Done()
			skip := ""
			if !force {
				skip = fmt.Sprintf("k3s crictl inspecti %s >/dev/null 2>&1 && exit 0", shellQuote(img))
			}
			errs[i] = shell.RunBash(fmt.Sprintf(`
				%[2]s
				for i in 1 2 3; do
				  k3s crictl pull %[1]s && exit 0
				  sleep 5
				done
				exit 1
			`, shellQuote(img), skip))
		}(i, img)
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			return fmt.Errorf("failed to pull %s: %w (is the package public on GHCR, or GITHUB_TOKEN set?)", imgs[i], err)
		}
	}
	return nil
}

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func InstallPlatform(cfg *config.Config) error {
	// Always reconcile security settings on existing installations as well.
	color.Cyan("\n  ■ Deploying Platform API + Portal...")

	if err := pullPlatformImages(cfg, false); err != nil {
		return err
	}

	apiImg := fmt.Sprintf("%s/platform-api:%s", cfg.ImageRegistry, cfg.ImageTag)
	portalImg := fmt.Sprintf("%s/platform-portal:%s", cfg.ImageRegistry, cfg.ImageTag)

	if err := applySecret("platform", "platform-env", map[string]string{
		"NODE_ENV": "production", "PORT": "3000", "JWT_SECRET": cfg.JWTSecret,
		"SECRETS_ENCRYPTION_KEY": cfg.SecretsEncryptionKey, "PLATFORM_WEBHOOK_SECRET": cfg.WebhookSecret,
		"POSTGRES_HOST": "postgresql.databases", "POSTGRES_PORT": "5432", "POSTGRES_DB": "platform", "POSTGRES_USER": "postgres", "POSTGRES_PASSWORD": cfg.PostgresPassword,
		"MONGODB_URI": "mongodb://root:" + url.QueryEscape(cfg.MongoPassword) + "@mongodb.databases:27017/platform?authSource=admin",
		"REDIS_HOST":  "redis-master.databases", "REDIS_PORT": "6379", "REDIS_PASSWORD": cfg.RedisPassword,
		"MINIO_ENDPOINT": "http://minio.storage:9000", "MINIO_ACCESS_KEY": cfg.MinioAccessKey, "MINIO_SECRET_KEY": cfg.MinioSecretKey,
		"PLATFORM_NAME": cfg.PlatformName, "DOMAIN": cfg.Domain, "ADMIN_EMAIL": cfg.AdminEmail, "ADMIN_PASSWORD": cfg.AdminPassword,
	}); err != nil {
		return err
	}
	rbac := readManifest("platform-api-rbac.yaml")
	if rbac == "" {
		return fmt.Errorf("platform-api RBAC manifest missing")
	}
	if _, err := shell.RunWithInput("kubectl", []string{"apply", "-f", "-"}, rbac); err != nil {
		return err
	}
	err := shell.RunBash(fmt.Sprintf(`
set -euo pipefail
export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
kubectl delete clusterrolebinding platform-api-admin-binding --ignore-not-found
# Rotation atomically renames files, requiring write access to the parent.
mkdir -p /etc/platform
chgrp 1000 /etc/platform
chmod 0770 /etc/platform
if [ -f /etc/platform/.env ]; then chown 1000:1000 /etc/platform/.env; chmod 0600 /etc/platform/.env; fi
install -d -m 0700 -o 1000 -g 1000 /etc/platform/credentials
find /etc/platform/credentials -maxdepth 1 -type f -exec chown 1000:1000 {} +
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
      serviceAccountName: platform-api
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        runAsGroup: 1000
        seccompProfile:
          type: RuntimeDefault
      containers:
      - name: api
        image: %s
        securityContext:
          allowPrivilegeEscalation: false
          capabilities:
            drop: ["ALL"]
        imagePullPolicy: IfNotPresent
        ports:
        - containerPort: 3000
        envFrom:
        - secretRef:
            name: platform-env
        volumeMounts:
        - name: platform-etc
          mountPath: /etc/platform
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
      volumes:
      - name: platform-etc
        hostPath:
          path: /etc/platform
          type: Directory
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
      automountServiceAccountToken: false
      securityContext:
        runAsNonRoot: true
        seccompProfile:
          type: RuntimeDefault
      containers:
      - name: portal
        image: %s
        securityContext:
          allowPrivilegeEscalation: false
          capabilities:
            drop: ["ALL"]
        imagePullPolicy: IfNotPresent
        ports:
        - containerPort: 8080
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
    targetPort: 8080

EOF

kubectl wait --for=condition=Available deployment/platform-api -n platform --timeout=300s
kubectl wait --for=condition=Available deployment/platform-portal -n platform --timeout=180s
`, strconv.Quote(apiImg), strconv.Quote(portalImg),
	))
	if err != nil {
		return err
	}
	// Ingress/routing is applied once by InstallRouting (runs after platform).
	color.Green("  ✓ Platform deployed")
	return state.MarkDone("platform")
}

// InstallRouting re-applies ingress so ArgoCD (full-page /argocd), Grafana
// (iframe /grafana), and Portainer (subdomain + /portainer redirect) stay correct.
// Also re-applies Portainer SSO in case Portainer was installed before ingress existed.
func InstallRouting(cfg *config.Config) error {
	if doneOrSkip("routing", "routing") {
		return nil
	}
	_ = state.MarkInProgress("routing")
	color.Cyan("\n  ■ Fixing service routing (ArgoCD / Grafana / Portainer)...")
	if err := ApplyServiceRouting(cfg); err != nil {
		return err
	}
	// Light subpath patch only — never wipe/reinstall ArgoCD during routing.
	if cfg.InstallArgoCD {
		_ = patchArgoCDSubpath(cfg)
	}
	// Grafana subpath/embedding settings are already in grafana-values.yaml at
	// install time — no second kube-prometheus-stack upgrade is needed.

	// Portainer SSO only if the install-time pass did not succeed (non-fatal).
	pass := cfg.PortainerPassword
	if pass == "" {
		pass = cfg.AdminPassword
	}
	if cfg.InstallPortainer && !state.IsDone("portainer-sso") && len(pass) >= 12 {
		if err := ensurePortainerAdminAndSSO(cfg, pass); err != nil {
			color.Yellow("  ⚠ Portainer SSO refresh: %v", err)
		} else {
			_ = state.MarkDone("portainer-sso")
		}
	}
	color.Green("  ✓ Routing applied")
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
# InstallIngressNginx already sets both at install; this cheap idempotent patch
# only covers clusters installed by older platformctl versions (no helm upgrade).
kubectl -n ingress-nginx patch configmap ingress-nginx-controller --type merge \
  -p '{"data":{"allow-snippet-annotations":"true","annotations-risk-level":"Critical"}}' >/dev/null || true

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
	color.Cyan("\n  ■ Seeding admin user (email + password)...")

	email := cfg.AdminEmail
	if email == "" {
		email = "admin@pratyushes.dev"
	}
	authFile, cleanup, err := privateJSON(map[string]string{"email": email, "password": cfg.AdminPassword})
	if err != nil {
		return err
	}
	defer cleanup()
	err = shell.RunBash(fmt.Sprintf(`
		export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
		API_IP="$(kubectl get svc -n platform platform-api -o jsonpath='{.spec.clusterIP}' 2>/dev/null || true)"
		URL="http://${API_IP:-platform-api.platform.svc.cluster.local}:3000"
		for i in $(seq 1 36); do
		  curl -sf "$URL/api/health" >/dev/null 2>&1 && break
		  sleep 5
		done
		# Upserts ONLY ADMIN_EMAIL — never john/sarah/devops demo accounts
		curl -sf "$URL/api/users/init-demo" || true
		TOKEN="$(curl -sf -X POST "$URL/api/auth/login" \
		  -H "Content-Type: application/json" \
		  -d %s | grep -o '"token":"[^"]*"' | cut -d'"' -f4 || true)"
		if [[ -z "$TOKEN" ]]; then
		  echo "WARN: could not obtain auth token for seeding — check ADMIN_EMAIL / ADMIN_PASSWORD and API logs" >&2
		  exit 0
		fi
		echo "Seed login OK"
	`, shellQuote("@"+authFile)))
	if err != nil {
		return fmt.Errorf("seed admin failed: %w", err)
	}
	color.Green("  ✓ Admin user seeded (%s)", email)
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
	fmt.Printf("    platformctl backup\n")
	fmt.Printf("    platformctl recover\n")
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

// UpdateImages resolves moving GHCR tags before changing the pod template.
func UpdateImages(cfg *config.Config) error {
	apiImg := fmt.Sprintf("%s/platform-api:%s", cfg.ImageRegistry, cfg.ImageTag)
	portalImg := fmt.Sprintf("%s/platform-portal:%s", cfg.ImageRegistry, cfg.ImageTag)
	return shell.RunBashEnv("export KUBECONFIG=\"${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}\"\nAPI="+shellQuote(apiImg)+"\nPORTAL="+shellQuote(portalImg)+"\n"+digestUpdateScript, map[string]string{"REGISTRY_USERNAME": "platformctl", "REGISTRY_PASSWORD": cfg.GitHubToken})
}

// InstallAutoUpdate installs a digest-aware updater for only two deployments.
func InstallAutoUpdate(cfg *config.Config) error {
	if !cfg.AutoUpdate {
		return nil
	}
	manifest := readManifest("auto-update-cronjob.yaml")
	if manifest == "" {
		return fmt.Errorf("auto-update manifest missing")
	}
	apiImg := fmt.Sprintf("%s/platform-api:%s", cfg.ImageRegistry, cfg.ImageTag)
	portalImg := fmt.Sprintf("%s/platform-portal:%s", cfg.ImageRegistry, cfg.ImageTag)
	if cfg.GitHubToken != "" {
		if err := applySecret("platform", "platform-update-registry", map[string]string{"username": "platformctl", "password": cfg.GitHubToken}); err != nil {
			return err
		}
	}
	apiJSON, _ := json.Marshal(apiImg)
	portalJSON, _ := json.Marshal(portalImg)
	manifest = strings.ReplaceAll(manifest, "\"{{API_IMAGE}}\"", string(apiJSON))
	manifest = strings.ReplaceAll(manifest, "\"{{PORTAL_IMAGE}}\"", string(portalJSON))
	// Retire the old tag-based GitOps updater so it cannot undo digest pins.
	if err := shell.RunBash(`set -euo pipefail
if [[ -n "$(kubectl get crd applications.argoproj.io --ignore-not-found -o name)" ]]; then
 if [[ -n "$(kubectl -n argocd get application platform --ignore-not-found -o name)" ]]; then
  kubectl -n argocd patch application platform --type=merge -p '{"metadata":{"annotations":{"argocd-image-updater.argoproj.io/image-list":null}},"spec":{"syncPolicy":{"automated":null}}}'
 fi
fi`); err != nil {
		return err
	}
	if _, err := shell.RunWithInput("kubectl", []string{"apply", "-f", "-"}, manifest); err != nil {
		return err
	}
	return state.MarkDone("auto-update")
}
