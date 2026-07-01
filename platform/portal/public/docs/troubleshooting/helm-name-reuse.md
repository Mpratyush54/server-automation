# Helm — "cannot re-use a name that is still in use"

## Symptom

> Running `helm install` returns: `Error: cannot re-use a name that is still in use`

## Root Cause

A Helm release with the same name already exists in the target namespace. `helm install` only works for *new* releases. Attempting to install over an existing release without removing it first causes this error.

## Fix

### Use `helm upgrade --install` instead of `helm install`

Replace:

```bash
helm install my-release ./chart --namespace my-namespace
```

With:

```bash
helm upgrade --install my-release ./chart --namespace my-namespace
```

`helm upgrade --install` performs an install if the release does not exist, or an upgrade if it does. This is idempotent and the recommended pattern for CI/CD.

### Alternatively, uninstall the existing release first

Only if you intend to start fresh:

```bash
helm uninstall my-release -n my-namespace
helm install my-release ./chart --namespace my-namespace
```

> **Warning**: Uninstalling removes the release record but **does not** delete all associated Kubernetes resources by default. Use `--wait` and `--timeout` with caution.

## Verification

```bash
helm list -n my-namespace
```

Expected output — the release is listed with a `STATUS` of `deployed`.

```bash
helm history my-release -n my-namespace
```

Shows the revision history (revision 1 for install, revision 2+ for upgrades).
