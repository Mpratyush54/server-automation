# Portainer — "Administrator initialization timeout"

## Symptom

> On first access to Portainer, the UI shows `Administrator initialization timeout`.

## Root Cause

Portainer enforces a 5-minute initialization lockout window after first startup. During this window a setup token is required to complete administrator account creation. If the UI is opened outside this window or the token is missing, the initialization process times out.

## Fix

Disable the setup token requirement by passing `--no-setup-token` via Helm values.

Create or update your `values.yaml`:

```yaml
# portainer-values.yaml
# ...
additionalArgs:
  - --no-setup-token
```

If installing via `--set`:

```bash
helm upgrade --install portainer portainer/portainer \
  --namespace portainer --create-namespace \
  --set service.type=ClusterIP \
  --set ingress.enabled=true \
  --set ingress.hosts[0].host=<your-domain> \
  --set ingress.hosts[0].paths[0].path=/ \
  --set "additionalArgs[0]=--no-setup-token"
```

> **Note**: Replace `<your-domain>` with your actual domain.

After deploying with `--no-setup-token`, Portainer will skip the token check and let you set the admin password directly.

## Verification

1. Access Portainer at `https://<your-domain>`.
2. The setup page should appear immediately — no timeout error.
3. Create the admin user and complete initialization.
