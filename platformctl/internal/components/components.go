package components

import (
	"encoding/json"
	"fmt"
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
		{"platform", "Platform API + Portal", InstallPlatform},
		{"ingress", "Create the Ingresses early so the TLS certificate issues during install", InstallIngress},
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
		"argocd", "portainer", "cert-manager",
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

// internalOIDC is the in-cluster base URL SSO clients use for server-to-server
// OIDC calls (token, userinfo, jwks), so SSO never depends on the public TLS
// certificate. Only the browser-facing authorize URL uses the public domain.
const internalOIDC = "http://platform-api.platform.svc.cluster.local:3000/api/oauth"

func writeTemplatedManifest(name string, cfg *config.Config, dest string) error {
	vals := readManifest(name)
	if vals == "" {
		return fmt.Errorf("%s manifest not found", name)
	}
	domain := cfg.Domain
	r := strings.NewReplacer(
		"{{DOMAIN}}", domain,
		"{{BASEHREF}}", "/argocd",
		"{{ARGOCD_URL}}", "https://"+domain+"/argocd",
		"{{OIDC_INTERNAL}}", internalOIDC,
		"{{OIDC_SECRET_GRAFANA}}", cfg.OIDCSecretGrafana,
		"{{OIDC_SECRET_ARGOCD}}", cfg.OIDCSecretArgoCD,
		"{{OIDC_SECRET_OAUTH2_PROXY}}", cfg.OIDCSecretOAuth2Proxy,
		"{{OIDC_SECRET_MINIO}}", cfg.OIDCSecretMinio,
	)
	// Values files can carry client secrets: keep them private.
	return os.WriteFile(dest, []byte(r.Replace(vals)), 0600)
}

func doneOrSkip(step, label string) bool {
	if state.IsDone(step) {
		color.Green("  ✓ %s already done", label)
		return true
	}
	return false
}

func InstallIngressNginx(cfg *config.Config) error {
	// Reconcile security defaults on existing installations too.
	color.Cyan("\n  ■ Installing ingress-nginx...")
	// allowSnippetAnnotations is required so portal iframes can hide
	// X-Frame-Options / CSP from ArgoCD/Grafana/Portainer backends.
	// Disable HSTS includeSubDomains so project hosts like
	// {app}.{ip}.sslip.io are not force-HTTPS'd with the default fake cert
	// before their own Let's Encrypt Ingress exists.
	err := helmValues("ingress-nginx", "ingress-nginx", "ingress-nginx", IngressSecurityValues(cfg), "--wait", "--timeout", "10m")
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
	if err := shell.RunBash(`helm upgrade --install cert-manager ` + chart("cert-manager") + ` \
			--namespace cert-manager --create-namespace \
			--set installCRDs=true --wait --timeout 5m`); err != nil {
		return err
	}
	// Let's Encrypt + internal-CA fallback issuers; an unusable contact email
	// is dropped instead of breaking ACME registration.
	if err := EnsureIssuers(cfg); err != nil {
		return err
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
	err := helmValues("redis", "redis", "databases", map[string]any{"auth": map[string]string{"password": cfg.RedisPassword}}, "--set", "master.persistence.size=5Gi",
		// Single server: one read replica. The chart default (3, started one at a
		// time) added ~1.5 minutes to every install for no redundancy.
		"--set", "replica.replicaCount=1", "--wait", "--timeout", "10m")
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
	tmpFile, err := temporaryManifest("minio-values.yaml", cfg)
	if err != nil {
		return err
	}
	defer os.Remove(tmpFile)

	err = helmValues("minio", "minio", "storage", map[string]any{"auth": map[string]string{"rootUser": cfg.MinioAccessKey, "rootPassword": cfg.MinioSecretKey}}, "-f", tmpFile, "--set", "persistence.size=50Gi", "--set", "image.repository=bitnamilegacy/minio", "--set", "console.image.repository=bitnamilegacy/minio-object-browser", "--set", `defaultBuckets=platform-backups\,platform-logs\,platform-uploads`, "--wait", "--timeout", "10m")
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
	tmpFile, err := temporaryManifest("argocd-values.yaml", cfg)
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
		    --set applicationSet.replicas=0 \
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
	tmpFile, err := temporaryManifest("grafana-values.yaml", cfg)
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
		# No --wait: nothing later needs the monitoring pods ready (routing only
		# creates the Grafana Ingress), so Grafana and Prometheus finish starting
		# while the rest of the platform installs. Waiting cost ~2 minutes.
		# Loki must not claim the default datasource: Grafana refuses to start when
		# two datasources are marked default (the kube-prometheus datasource already is).
		helm upgrade --install loki %[3]s \
			--namespace monitoring --create-namespace \
			--set grafana.enabled=false \
			--set prometheus.enabled=false \
			--set loki.isDefault=false \
			--timeout 10m > /tmp/platformctl-loki.log 2>&1 &
		loki_pid=$!
		helm upgrade --install kube-prometheus %[4]s \
			--namespace monitoring --create-namespace \
			-f %[1]s \
			-f %[2]s \
			--set grafana.assertNoLeakedSecrets=false \
			--set prometheus.prometheusSpec.retention=30d \
			--timeout 10m
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
	tmpFile, err := temporaryManifest("oauth2-proxy-values.yaml", cfg)
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
	tmpFile, err := temporaryManifest("portainer-values.yaml", cfg)
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
	// Portainer's own client secret (registered with the API via OIDC_CLIENTS).
	oauthSecret := cfg.OIDCSecretPortainer
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
    "AccessTokenURI": "%[2]s/token",
    "AuthorizationURI": "https://%[3]s/api/oauth/authorize",
    "ResourceURI": "%[2]s/userinfo",
    "RedirectURI": "https://portainer.%[3]s/",
    "UserIdentifier": "email",
    "Scopes": "openid profile email groups",
    "OAuthAutoCreateUsers": true,
    "DefaultTeamID": 0,
    "SSO": true,
    "LogoutURI": "",
    "AuthStyle": 1
  }
}`, oauthSecret, internalOIDC, domain)
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

// apiReplicas is the platform-api replica count (at least 1).
func apiReplicas(cfg *config.Config) int {
	if cfg.APIReplicas < 1 {
		return 1
	}
	return cfg.APIReplicas
}

// apiPDBScript applies a PodDisruptionBudget (minAvailable: 1) when the API runs
// more than one replica so node drains keep one pod serving. With a single
// replica a PDB would block drains forever, so any old one is removed.
func apiPDBScript(replicas int) string {
	if replicas < 2 {
		return "kubectl delete pdb platform-api -n platform --ignore-not-found"
	}
	return `kubectl apply -n platform -f - <<'EOF'
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: platform-api
  namespace: platform
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: platform-api
EOF`
}

// apiRolloutPatch is a strategic-merge patch carrying the #18 rollout settings
// of the InstallPlatform manifest (replicas, surge-only strategy, drain grace,
// preStop, readiness on /api/health/ready, liveness on /api/health). `update`
// applies it after the new image is rolled, so an existing install converges
// to the same Deployment as a fresh provision. Never before: an image older
// than this release has no /api/health/ready and would never become ready.
func apiRolloutPatch(replicas int) string {
	probe := func(path string, initial, period int) map[string]any {
		return map[string]any{
			"httpGet":             map[string]any{"path": path, "port": 3000},
			"initialDelaySeconds": initial, "periodSeconds": period,
			"timeoutSeconds": 3, "failureThreshold": 3,
		}
	}
	patch := map[string]any{"spec": map[string]any{
		"replicas": replicas,
		"strategy": map[string]any{"type": "RollingUpdate", "rollingUpdate": map[string]any{"maxUnavailable": 0, "maxSurge": 1}},
		"template": map[string]any{"spec": map[string]any{
			"terminationGracePeriodSeconds": 45,
			"containers": []any{map[string]any{
				"name":           "api",
				"lifecycle":      map[string]any{"preStop": map[string]any{"exec": map[string]any{"command": []string{"sleep", "10"}}}},
				"readinessProbe": probe("/api/health/ready", 5, 5),
				"livenessProbe":  probe("/api/health", 30, 20),
			}},
		}},
	}}
	b, _ := json.Marshal(patch)
	return string(b)
}

// reconcileAPIRollout applies apiRolloutPatch and the matching PDB to the live
// platform-api Deployment and waits for the rollout.
func reconcileAPIRollout(cfg *config.Config) error {
	replicas := apiReplicas(cfg)
	return shell.RunBash(`set -euo pipefail
export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
kubectl -n platform patch deployment platform-api --type strategic -p ` + shellQuote(apiRolloutPatch(replicas)) + ` >/dev/null
` + apiPDBScript(replicas) + `
kubectl -n platform rollout status deployment/platform-api --timeout=300s
`)
}

// deploymentReadyCheck succeeds when every desired replica of the deployment is ready.
func deploymentReadyCheck(ns, name string) string {
	return fmt.Sprintf(`k3s kubectl get deployment -n %s %s -o jsonpath='{.status.readyReplicas} {.spec.replicas}' 2>/dev/null | awk '$1 != "" && $1 == $2 { ok = 1 } END { exit !ok }'`, ns, name)
}

func InstallPlatform(cfg *config.Config) error {
	// Always reconcile security settings on existing installations as well.
	color.Cyan("\n  ■ Deploying Platform API + Portal...")

	if err := pullPlatformImages(cfg, false); err != nil {
		return err
	}

	apiImg := fmt.Sprintf("%s/platform-api:%s", cfg.ImageRegistry, cfg.ImageTag)
	portalImg := fmt.Sprintf("%s/platform-portal:%s", cfg.ImageRegistry, cfg.ImageTag)

	// Credentials (incl. ones the API rotated at runtime) → platform-credentials,
	// OIDC signing key → platform-oidc-signing-key; /etc/platform becomes a
	// root-only break-glass copy. Must run before platform-env is applied so a
	// rotated webhook secret is adopted rather than overwritten.
	if err := MigrateHostState(cfg); err != nil {
		return err
	}
	if err := applySecret("platform", "platform-env", map[string]string{
		"NODE_ENV": "production", "PORT": "3000", "JWT_SECRET": cfg.JWTSecret,
		"SECRETS_ENCRYPTION_KEY": cfg.SecretsEncryptionKey, "PLATFORM_WEBHOOK_SECRET": cfg.WebhookSecret,
		"POSTGRES_HOST": "postgresql.databases", "POSTGRES_PORT": "5432", "POSTGRES_DB": "platform", "POSTGRES_USER": "postgres",
		"REDIS_HOST": "redis-master.databases", "REDIS_PORT": "6379",
		"MINIO_ENDPOINT": "http://minio.storage:9000",
		"UPLOADS_BUCKET": "platform-uploads", "BACKUP_BUCKET": "platform-backups",
		"PLATFORM_NAME": cfg.PlatformName, "DOMAIN": cfg.Domain, "ADMIN_EMAIL": cfg.AdminEmail,
		"OIDC_ISSUER": cfg.OIDCIssuer(), "OIDC_CLIENTS": cfg.OIDCClientsJSON(),
		"CORS_ORIGINS": "https://" + cfg.Domain,
	}); err != nil {
		return err
	}
	if err := applyAPIRBAC(); err != nil {
		return err
	}
	// Backup + platform-api-migrate Job before the API Deployment changes (#17).
	if err := RunAPIMigrations(cfg, apiImg); err != nil {
		return err
	}
	err := shell.RunBash(fmt.Sprintf(`
set -euo pipefail
export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
kubectl delete clusterrolebinding platform-api-admin-binding --ignore-not-found
kubectl apply -n platform -f - <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: platform-api
  namespace: platform
  labels:
    app: platform-api
spec:
  replicas: %[3]d
  # Zero-downtime rollouts: start a new pod and wait for readiness before
  # removing an old one.
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 0
      maxSurge: 1
  selector:
    matchLabels:
      app: platform-api
  template:
    metadata:
      labels:
        app: platform-api
    spec:
      serviceAccountName: platform-api
      # preStop sleep (10s) + in-process drain (SHUTDOWN_TIMEOUT_MS, 25s) + margin.
      terminationGracePeriodSeconds: 45
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        runAsGroup: 1000
        seccompProfile:
          type: RuntimeDefault
      containers:
      - name: api
        image: %[1]s
        securityContext:
          allowPrivilegeEscalation: false
          capabilities:
            drop: ["ALL"]
        imagePullPolicy: IfNotPresent
        ports:
        - containerPort: 3000
        # Config and keys come from Secrets only (no node mounts): the pod can
        # be rescheduled to any node. platform-credentials wins on duplicates.
        envFrom:
        - secretRef:
            name: platform-env
        - secretRef:
            name: platform-credentials
        lifecycle:
          preStop:
            # Keep serving while the endpoint is removed from Services/ingress;
            # SIGTERM then drains in-flight requests (server.ts).
            exec:
              command: ["sleep", "10"]
        readinessProbe:
          # PostgreSQL reachable + not draining (Redis outages must not empty the Service).
          httpGet:
            path: /api/health/ready
            port: 3000
          initialDelaySeconds: 5
          periodSeconds: 5
          timeoutSeconds: 3
          failureThreshold: 3
        livenessProbe:
          # Process only; dependency outages must not restart the API.
          httpGet:
            path: /api/health
            port: 3000
          initialDelaySeconds: 30
          periodSeconds: 20
          timeoutSeconds: 3
          failureThreshold: 3
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
      automountServiceAccountToken: false
      securityContext:
        runAsNonRoot: true
        seccompProfile:
          type: RuntimeDefault
      containers:
      - name: portal
        image: %[2]s
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

%[4]s
kubectl wait --for=condition=Available deployment/platform-api -n platform --timeout=300s
kubectl wait --for=condition=Available deployment/platform-portal -n platform --timeout=180s
`, strconv.Quote(apiImg), strconv.Quote(portalImg), apiReplicas(cfg), apiPDBScript(apiReplicas(cfg)),
	))
	if err != nil {
		return err
	}
	if err := stripCredentialKeysFromEnvSecret(); err != nil {
		color.Yellow("  ⚠ %v", err)
	}
	// Ingress/routing is applied once by InstallRouting (runs after platform).
	color.Green("  ✓ Platform deployed")
	return state.MarkDone("platform")
}

// InstallRouting re-applies ingress so ArgoCD (full-page /argocd), Grafana
// (iframe /grafana), and Portainer (subdomain + /portainer redirect) stay correct.
// Also re-applies Portainer SSO in case Portainer was installed before ingress existed.
// InstallIngress creates every Ingress (and the certificate issuers) as soon
// as ingress-nginx and cert-manager run, so cert-manager requests the TLS
// certificate while the databases and the platform are still installing.
// Backends that do not exist yet just answer 503 until they start. Routing
// re-applies the same objects later and then finds the certificate issued:
// waiting for Let's Encrypt at the end cost ~45 s on every install.
func InstallIngress(cfg *config.Config) error {
	color.Cyan("\n  ■ Creating Ingresses early (TLS certificate issues during install)...")
	if cfg.InstallCertManager {
		if err := EnsureIssuers(cfg); err != nil {
			// Not fatal: routing applies the issuers again and handles fallback.
			color.Yellow("  ⚠ certificate issuers: %v (routing will retry)", err)
		}
	}
	if err := ApplyServiceRouting(cfg); err != nil {
		return err
	}
	color.Green("  ✓ Ingresses created")
	return nil
}

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
	// Only once Portainer's own step finished: routing no longer waits for it,
	// and that step configures SSO itself on the first install.
	if cfg.InstallPortainer && state.IsDone("portainer") && !state.IsDone("portainer-sso") && len(pass) >= 12 {
		if err := ensurePortainerAdminAndSSO(cfg, pass); err != nil {
			color.Yellow("  ⚠ Portainer SSO refresh: %v", err)
		} else {
			_ = state.MarkDone("portainer-sso")
		}
	}
	// A valid certificate (Let's Encrypt, or the internal CA as fallback) plus
	// SSO client trust. Failure here is reported, not fatal: `platformctl
	// repair` re-runs it, and the internal-endpoint SSO wiring keeps Grafana,
	// Portainer and oauth2-proxy working regardless.
	if err := EnsureTLS(cfg); err != nil {
		color.Yellow("  ⚠ TLS not ready: %v — run `sudo platformctl repair`", err)
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
    cert-manager.io/cluster-issuer: __ISSUER__
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
    - minio.__DOMAIN__
    secretName: platform-tls
  rules:
  # MinIO console on its own host: its SSO redirect is https://minio.DOMAIN/oauth_callback.
  - host: minio.__DOMAIN__
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: minio-proxy
            port:
              number: 9090
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
	// Only the main Ingress requests the certificate; the others reuse platform-tls.
	script = strings.ReplaceAll(script, "__ISSUER__", ActiveIssuer())
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
		{"Platform API", deploymentReadyCheck("platform", "platform-api")},
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

// imagePresentLocally reports whether containerd already has the image (e.g.
// imported from an offline bundle). Swapped in tests.
var imagePresentLocally = func(image string) bool {
	return shell.RunSilent("k3s", "crictl", "inspecti", image) == nil
}

// UpdateImages resolves moving GHCR tags before changing the pod template.
// Order (after PrepareUpdate moved host state into Secrets, #20): migration Job
// template + database backup, then the digest script runs the migrate Job and
// only then sets the new images (#17); finally the #18 rollout settings and PDB
// are reconciled on the new image.
func UpdateImages(cfg *config.Config) error {
	apiImg := fmt.Sprintf("%s/platform-api:%s", cfg.ImageRegistry, cfg.ImageTag)
	portalImg := fmt.Sprintf("%s/platform-portal:%s", cfg.ImageRegistry, cfg.ImageTag)
	backup, err := prepareAPIMigrations(cfg)
	if err != nil {
		return err
	}
	env := map[string]string{"REGISTRY_USERNAME": "platformctl", "REGISTRY_PASSWORD": cfg.GitHubToken, "MIGRATE_BACKUP": backup}
	// Offline/bundle installs have no registry to resolve digests from. Allow
	// the already-imported images only when both are present on the node.
	if imagePresentLocally(apiImg) && imagePresentLocally(portalImg) {
		env["ALLOW_LOCAL_IMAGES"] = "true"
	}
	if err := shell.RunBashEnv("export KUBECONFIG=\"${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}\"\nAPI="+shellQuote(apiImg)+"\nPORTAL="+shellQuote(portalImg)+"\n"+digestUpdateScript, env); err != nil {
		return err
	}
	return reconcileAPIRollout(cfg)
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
