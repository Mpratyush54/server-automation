# Ingress — "exists and cannot be imported" during Helm install

## Symptom

> Helm install fails with: `Error: Ingress "..." exists and cannot be imported into the current release`

## Root Cause

A previous Helm release created an Ingress resource. When the release was uninstalled (or deleted without `--purge`), the Ingress was left behind as an orphaned resource. The new Helm release sees the existing Ingress but cannot adopt it because it lacks the correct Helm ownership labels and annotations.

## Fix

Add the required Helm labels and annotations to the orphaned Ingress so the new release can adopt it.

### Required labels and annotations

| Key | Value |
|-----|-------|
| `app.kubernetes.io/managed-by` | `Helm` |
| `helm.sh/chart` | `<chart-name>-<chart-version>` (matching your chart) |

### Step-by-step

1. **Annotate and label the existing Ingress**

```bash
kubectl annotate ingress <ingress-name> -n <namespace> \
  meta.helm.sh/release-name=<release-name> \
  meta.helm.sh/release-namespace=<namespace> \
  --overwrite

kubectl label ingress <ingress-name> -n <namespace> \
  app.kubernetes.io/managed-by=Helm \
  --overwrite
```

Replace:
- `<ingress-name>` — name of the existing orphaned Ingress
- `<namespace>` — namespace of the release
- `<release-name>` — name of the Helm release you are installing

### 2. Retry the Helm install

```bash
helm upgrade --install <release-name> ./chart --namespace <namespace>
```

## Verification

```bash
kubectl get ingress <ingress-name> -n <namespace> -o json \
  | jq '.metadata.labels["app.kubernetes.io/managed-by"]'
```

Expected output: `"Helm"`

```bash
helm list -n <namespace>
```

Expected output — release is `deployed` without errors.
