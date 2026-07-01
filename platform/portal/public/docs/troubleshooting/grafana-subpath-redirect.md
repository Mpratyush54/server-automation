# Grafana — `/grafana` redirects to `/`

## Symptom

> Accessing `https://<domain>/grafana` redirects to `https://<domain>/` (root), resulting in a blank page or a different application.

## Root Cause

Grafana's `GF_SERVER_ROOT_URL` environment variable defaults to `https://localhost:3000/`. When Grafana is served behind a reverse-proxy under a subpath, it generates redirect URLs pointing to the root. Without `GF_SERVER_SERVE_FROM_SUB_PATH=true`, Grafana does not strip or handle the subpath prefix correctly.

## Fix

### Set the exact Helm values

In your Grafana `values.yaml`:

```yaml
# grafana-values.yaml
env:
  GF_SERVER_ROOT_URL: https://<domain>/grafana
  GF_SERVER_SERVE_FROM_SUB_PATH: true
```

Or pass via `--set` on install/upgrade:

```bash
helm upgrade --install grafana grafana/grafana \
  --namespace grafana --create-namespace \
  --set "env.GF_SERVER_ROOT_URL=https://<domain>/grafana" \
  --set "env.GF_SERVER_SERVE_FROM_SUB_PATH=true" \
  --set ingress.enabled=true \
  --set "ingress.hosts[0].host=<domain>" \
  --set "ingress.hosts[0].paths[0].path=/grafana" \
  --set "ingress.hosts[0].paths[0].pathType=Prefix"
```

> **Note**: Replace `<domain>` with your actual domain (e.g., `dev.example.com`).

### Verify the environment variables took effect

```bash
kubectl get pods -n grafana -l app.kubernetes.io/name=grafana -o name \
  | head -1 | xargs -I{} kubectl exec {} -n grafana -- env \
  | grep -E "GF_SERVER_ROOT_URL|GF_SERVER_SERVE_FROM_SUB_PATH"
```

Expected output:

```
GF_SERVER_ROOT_URL=https://<domain>/grafana
GF_SERVER_SERVE_FROM_SUB_PATH=true
```

## Verification

1. Navigate to `https://<domain>/grafana`.
2. The Grafana login page should appear — not a redirect to root.
3. All subsequent Grafana page and API URLs should include the `/grafana` prefix.
