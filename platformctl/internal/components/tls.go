package components

import (
	"fmt"
	"strings"
	"time"

	"github.com/fatih/color"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/shell"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/state"
)

// TLS issuers. Let's Encrypt is preferred; the in-cluster CA is the fallback
// when Let's Encrypt cannot issue (bad contact email, no public DNS, port 80
// blocked, rate limits) so HTTPS and SSO keep working instead of serving the
// ingress controller's fake "ingress.local" certificate.
const (
	IssuerLetsEncrypt = "letsencrypt-prod"
	IssuerPlatformCA  = "platform-ca"

	// tlsFallbackKey is set in the bootstrap state while the CA fallback is active.
	tlsFallbackKey = "tls-fallback"

	platformTLSSecret = "platform-tls"
)

// leWait is how long EnsureTLS waits for a Let's Encrypt certificate before
// falling back. Variable so tests can shorten it.
var leWait = 4 * time.Minute

// ActiveIssuer is the ClusterIssuer routing should reference.
func ActiveIssuer() string {
	if state.IsDone(tlsFallbackKey) {
		return IssuerPlatformCA
	}
	return IssuerLetsEncrypt
}

// IssuersManifest renders the ClusterIssuers. An unusable contact email is
// omitted (ACME accounts do not require one) instead of breaking registration.
func IssuersManifest(email string) string {
	contact := ""
	if config.ValidACMEEmail(email) {
		contact = fmt.Sprintf("    email: %s\n", email)
	}
	return `apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: ` + IssuerLetsEncrypt + `
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
` + contact + `    privateKeySecretRef:
      name: letsencrypt-prod
    solvers:
    - http01:
        ingress:
          ingressClassName: nginx
---
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: platform-selfsigned
spec:
  selfSigned: {}
---
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: platform-ca
  namespace: cert-manager
spec:
  isCA: true
  commonName: Platform Internal CA
  secretName: platform-ca
  duration: 87600h
  privateKey:
    algorithm: ECDSA
    size: 256
  issuerRef:
    name: platform-selfsigned
    kind: ClusterIssuer
---
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: ` + IssuerPlatformCA + `
spec:
  ca:
    secretName: platform-ca
`
}

// EnsureIssuers applies the ClusterIssuers idempotently and repairs a Let's
// Encrypt account whose registration failed (e.g. invalid contact email).
func EnsureIssuers(cfg *config.Config) error {
	email := cfg.LEEmail
	if email == "" {
		email = cfg.AdminEmail
	}
	if email != "" && !config.ValidACMEEmail(email) {
		color.Yellow("  ⚠ Let's Encrypt contact %q is not a deliverable public address — registering without a contact email", email)
	}
	script := `set -euo pipefail
export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
# A failed ACME registration is cached on the account key; drop it so the
# corrected issuer registers again.
msg="$(kubectl get clusterissuer ` + IssuerLetsEncrypt + ` -o jsonpath='{.status.conditions[0].message}' 2>/dev/null || true)"
if [[ "$msg" == *"Failed to register ACME account"* ]]; then
  echo "Repairing Let's Encrypt account: $msg"
  kubectl -n cert-manager delete secret letsencrypt-prod --ignore-not-found
fi
kubectl apply -f - <<'EOF'
` + IssuersManifest(email) + `EOF
`
	return shell.RunBash(script)
}

// certStatus returns Ready status and the latest reason for the platform cert.
func certStatus() (ready bool, detail string) {
	out, _ := shell.OutputBash(`export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
kubectl -n platform get certificate ` + platformTLSSecret + ` -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}|{.status.conditions[?(@.type=="Ready")].message}' 2>/dev/null`)
	parts := strings.SplitN(out, "|", 2)
	ready = len(parts) > 0 && parts[0] == "True"
	if len(parts) == 2 {
		detail = parts[1]
	}
	return ready, detail
}

// servedIssuer reports which issuer signed the certificate currently stored.
func servedIssuer() string {
	out, _ := shell.OutputBash(`export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
kubectl -n platform get certificate ` + platformTLSSecret + ` -o jsonpath='{.spec.issuerRef.name}' 2>/dev/null`)
	return strings.TrimSpace(out)
}

func waitCertReady(timeout time.Duration) (bool, string) {
	deadline := time.Now().Add(timeout)
	var detail string
	for {
		ready, d := certStatus()
		detail = d
		if ready {
			return true, detail
		}
		if time.Now().After(deadline) {
			return false, detail
		}
		time.Sleep(10 * time.Second)
	}
}

// acmeDiagnosis summarises why Let's Encrypt has not issued yet.
func acmeDiagnosis() string {
	out, _ := shell.OutputBash(`export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
kubectl get clusterissuer ` + IssuerLetsEncrypt + ` -o jsonpath='issuer: {.status.conditions[0].message}{"\n"}' 2>/dev/null
kubectl get challenges -A -o jsonpath='{range .items[*]}challenge {.spec.dnsName}: {.status.state} {.status.reason}{"\n"}{end}' 2>/dev/null
kubectl get orders -A -o jsonpath='{range .items[*]}order: {.status.state} {.status.reason}{"\n"}{end}' 2>/dev/null`)
	return strings.TrimSpace(out)
}

// switchIssuer points the platform Ingress at issuer; cert-manager then
// reissues platform-tls. The current secret keeps serving until a new
// certificate is ready, so a failed switch never removes a working cert.
func switchIssuer(issuer string) error {
	return shell.RunBash(fmt.Sprintf(`set -euo pipefail
export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
kubectl -n platform annotate ingress platform cert-manager.io/cluster-issuer=%s --overwrite >/dev/null
`, issuer))
}

// EnsureTLS makes sure the platform serves a valid certificate and that every
// SSO client trusts it. It is idempotent and safe to re-run (`platformctl repair`).
//
//  1. Prefer Let's Encrypt: if it issues within leWait, use it.
//  2. Otherwise fall back to the in-cluster CA (always issuable) and record it,
//     so the next run retries Let's Encrypt and switches back automatically.
//  3. Point ArgoCD (the only client that fetches OIDC discovery over the public
//     URL) at the matching CA, then restart SSO clients that may have cached a
//     failure.
func EnsureTLS(cfg *config.Config) error {
	if !cfg.InstallCertManager {
		color.Yellow("  ○ cert-manager disabled — skipping TLS repair")
		return nil
	}
	color.Cyan("\n  ■ Ensuring a valid TLS certificate for %s...", cfg.Domain)
	if err := EnsureIssuers(cfg); err != nil {
		return fmt.Errorf("apply issuers: %w", err)
	}

	if servedIssuer() != IssuerLetsEncrypt {
		_ = switchIssuer(IssuerLetsEncrypt)
	}
	if ok, _ := waitCertReady(leWait); ok && servedIssuer() == IssuerLetsEncrypt {
		_ = state.Clear(tlsFallbackKey)
		color.Green("  ✓ Let's Encrypt certificate issued")
		return trustAndRestartSSO(false)
	}

	color.Yellow("  ⚠ Let's Encrypt has not issued a certificate yet:")
	for _, l := range strings.Split(acmeDiagnosis(), "\n") {
		if l != "" {
			color.Yellow("      %s", l)
		}
	}
	color.Yellow("    Falling back to the platform's internal CA so HTTPS and SSO work now.")
	color.Yellow("    Browsers will warn until Let's Encrypt succeeds; re-run `sudo platformctl repair` after fixing DNS/port 80/email.")

	if err := switchIssuer(IssuerPlatformCA); err != nil {
		return fmt.Errorf("switch to internal CA: %w", err)
	}
	if ok, detail := waitCertReady(2 * time.Minute); !ok {
		return fmt.Errorf("internal CA certificate not ready: %s", detail)
	}
	_ = state.MarkDone(tlsFallbackKey)
	color.Green("  ✓ Internal CA certificate active")
	return trustAndRestartSSO(true)
}

// trustAndRestartSSO configures ArgoCD's OIDC rootCA for the active issuer and
// restarts SSO clients so they re-query the provider with the new trust.
func trustAndRestartSSO(useCA bool) error {
	mode := "le"
	if useCA {
		mode = "ca"
	}
	return shell.RunBash(`set -uo pipefail
export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
MODE=` + mode + `
if kubectl -n argocd get configmap argocd-cm >/dev/null 2>&1; then
  CA=""
  if [[ "$MODE" == "ca" ]]; then
    CA="$(kubectl -n cert-manager get secret platform-ca -o jsonpath='{.data.ca\.crt}' | base64 -d)"
  fi
  kubectl -n argocd get configmap argocd-cm -o json | CA="$CA" python3 -c '
import json, os, sys
cm = json.load(sys.stdin)
cfg = cm.get("data", {}).get("oidc.config", "")
lines, skip = [], False
for l in cfg.splitlines():
    if l.startswith("rootCA:"):
        skip = True
        continue
    if skip and (l.startswith(" ") or not l.strip()):
        continue
    skip = False
    lines.append(l)
ca = os.environ.get("CA", "").strip()
if ca:
    lines.append("rootCA: |")
    lines += ["  " + c for c in ca.splitlines()]
cm["data"]["oidc.config"] = "\n".join(lines) + "\n"
json.dump(cm, sys.stdout)
' | kubectl apply -f - >/dev/null && echo "ArgoCD OIDC trust: $MODE"
  kubectl -n argocd rollout restart deploy/argocd-server >/dev/null 2>&1 || true
fi
kubectl -n monitoring rollout restart deploy/kube-prometheus-grafana >/dev/null 2>&1 || true
kubectl -n oauth2-proxy rollout restart deploy/oauth2-proxy >/dev/null 2>&1 || true
exit 0
`)
}
