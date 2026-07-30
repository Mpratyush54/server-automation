# Portainer — "Administrator initialization timeout"

## Symptom

> On first access to Portainer, the UI shows `Administrator initialization timeout`
> or redirects to `/timeout.html`.

## Root Cause

Portainer enforces a short initialization window after first startup unless
`--no-setup-token` is set. Older chart installs also left you on a manual
"create administrator" screen with no SSO.

## Fix (preferred)

`platformctl` now handles this automatically:

```bash
sudo platformctl install portainer
sudo platformctl install routing
```

That will:

1. Seed admin via `adminPassword.existingSecret` (no setup wizard)
2. Pass `--no-setup-token`
3. Enable Platform OAuth/SSO (`AuthenticationMethod=3`)
4. Keep Portainer on `https://portainer.<domain>/` (path `/portainer` redirects)

Login with **Platform SSO**. Fallback admin password is
`PORTAINER_ADMIN_PASSWORD` in `/etc/platform/.env` (same as `ADMIN_PASSWORD`
on fresh installs).

## Manual fix

```bash
kubectl -n portainer create secret generic portainer-admin-password \
  --from-literal=password='YOUR_PASSWORD_AT_LEAST_12_CHARS' \
  --dry-run=client -o yaml | kubectl apply -f -

helm upgrade --install portainer portainer/portainer \
  --namespace portainer \
  --set service.type=ClusterIP \
  --set adminPassword.existingSecret=portainer-admin-password \
  --set 'feature.flags[0]=--no-setup-token'

# If admin still missing, reset the volume once then re-run platformctl:
kubectl -n portainer delete deploy portainer
kubectl -n portainer delete pvc portainer
sudo platformctl install portainer
```

## Verification

```bash
curl -sk https://portainer.<domain>/api/settings/public
# expect AuthenticationMethod: 3 and a non-empty OAuthLoginURI
```
