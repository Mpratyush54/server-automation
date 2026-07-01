# ArgoCD — `/argocd` returns HTTP 404

## Symptom

> Accessing `https://<domain>/argocd` returns an HTTP 404 page.

## Root Cause

ArgoCD's `argocd-server` is started with the default `--rootpath=/` flag, so it expects to be served at the root path. The nginx ingress, however, proxies `/argocd` to `argocd-server:8080/argocd`. The server has no route for this subpath and responds with 404.

## Fix

### 1. Patch the ArgoCD server deployment to set `--rootpath=/argocd`

```bash
kubectl patch deployment argocd-server -n argocd --type=json \
  -p='[{"op": "add", "path": "/spec/template/spec/containers/0/args/-", "value": "--rootpath=/argocd"}]'
```

### 2. Update or create the `argocd-cmd-params-cm` ConfigMap with `server.rootpath`

```bash
kubectl patch configmap argocd-cmd-params-cm -n argocd --type=merge \
  -p='{"data":{"server.rootpath":"/argocd"}}'
```

If the ConfigMap does not exist, create it:

```bash
kubectl create configmap argocd-cmd-params-cm -n argocd \
  --from-literal=server.rootpath=/argocd
```

### 3. Restart the ArgoCD server pods

```bash
kubectl rollout restart deployment argocd-server -n argocd
kubectl rollout status deployment argocd-server -n argocd
```

## Verification

```bash
curl -s -o /dev/null -w "%{http_code}" https://<domain>/argocd
```

Expected output: `200`

Open `https://<domain>/argocd` in a browser — the ArgoCD login page should render correctly.
