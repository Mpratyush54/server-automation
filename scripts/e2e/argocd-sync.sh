#!/usr/bin/env bash
# Argo CD sync of a sample app: an Application for examples/sdk-demo/k8s at the
# commit under test must become Synced and Healthy. Needs KUBECONFIG and
# E2E_REPO_URL / E2E_REVISION (defaults: this GitHub repository and commit).
set -euo pipefail

repo="${E2E_REPO_URL:-${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-Mpratyush54/server-automation}.git}"
rev="${E2E_REVISION:-${GITHUB_SHA:-master}}"
app=e2e-argocd-sample
ns=e2e-argocd-sample
[[ "$rev" =~ ^[A-Za-z0-9._/-]+$ && "$repo" =~ ^https://[A-Za-z0-9./_-]+$ ]] || { echo "unsafe repo or revision" >&2; exit 1; }

kubectl apply -f - >/dev/null <<EOF
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: $app
  namespace: argocd
spec:
  project: default
  source:
    repoURL: $repo
    targetRevision: $rev
    path: examples/sdk-demo/k8s
  destination:
    server: https://kubernetes.default.svc
    namespace: $ns
  syncPolicy:
    automated: {}
    syncOptions:
      - CreateNamespace=true
EOF

state=""
for _ in $(seq 1 60); do
  state=$(kubectl -n argocd get application "$app" -o jsonpath='{.status.sync.status}/{.status.health.status}' 2>/dev/null || true)
  if [[ "$state" == Synced/Healthy ]]; then break; fi
  sleep 8
done
echo "  application state: ${state:-unknown}"
if [[ "$state" != Synced/Healthy ]]; then
  kubectl -n argocd get application "$app" -o jsonpath='{range .status.conditions[*]}{.type}: {.message}{"\n"}{end}' || true
  exit 1
fi
[[ "$(kubectl -n "$ns" get deploy sdk-demo -o jsonpath='{.status.readyReplicas}')" == 1 ]]
echo "  argocd synced and deployed the sample app at the commit under test"
kubectl -n argocd delete application "$app" --wait=false >/dev/null || true
