# Platform SDK demo apps (Node + React + Angular)

End-to-end proof that the SDK owns DevOps + DBs + telemetry on the cluster.

## What the SDK does on `init()`

1. **Register** → creates/refreshes ArgoCD Application from `repositoryUrl` + `gitPath`
2. **Ensure DBs** → creates project Postgres / Mongo / Redis credentials if missing and returns them via `/api/sdk/db-credentials`
3. **Ingress TLS** → wires HTTPS host for the Node service
4. **Telemetry** → heartbeats + per-route API latency

You only need to **build/import images** (and bootstrap the same manifests once until they are on `main` for Argo).

## Hosts

`k8s/all.yaml` uses the placeholder `__DOMAIN__` for every Ingress host and URL; the deploy
script substitutes your platform's `DOMAIN` (e.g. `sed "s/__DOMAIN__/$DOMAIN/g" k8s/all.yaml | kubectl apply -f -`).

| App | URL |
|-----|-----|
| Node API + SDK | https://sdk-demo-apps-development.__DOMAIN__/health |
| DB check | https://sdk-demo-apps-development.__DOMAIN__/api/db-check |
| React | https://sdk-react.__DOMAIN__ |
| Angular | https://sdk-angular.__DOMAIN__ |

The React and Angular images run unprivileged nginx (UID 101) on port **8080**; their
containers and Services target 8080 (the Services still expose port 80 to the Ingress).

Portal project: **sdk-demo-apps** → Metrics / API Latency.

## Deploy on VPS

```bash
# On your machine: upload sources, then on VPS:
PLATFORM_URL='https://platform.example.com' PROJECT_DOMAIN='example.com' \
ADMIN_EMAIL='admin@example.com' ADMIN_PASSWORD='<your-admin-password>' \
bash scripts/vps-deploy-sdk-apps.sh /tmp/sdk-apps-src
```

## Package-level examples (snippets)

| SDK | Path |
|-----|------|
| Node | [`sdk-node/examples`](../../sdk-node/examples) |
| React | [`sdk-react/examples`](../../sdk-react/examples) |
| Angular | [`sdk-angular/examples`](../../sdk-angular/examples) |
| Python | [`sdk-python/examples`](../../sdk-python/examples) |

Docs index: [`docs/getting-started/sdk-examples.md`](../../docs/getting-started/sdk-examples.md)

## Local demos

```powershell
cd examples/sdk-apps
$env:PLATFORM_URL='https://platform.example.com'
$env:PROJECT_DOMAIN='example.com'
$env:PLATFORM_SDK_TOKEN='sdk_live_...'
./start-demos.ps1
```

## Automated checks

```powershell
# Unit (API)
cd platform/api
npx jest --forceExit tests/unit/project-db-ensure.test.ts

# Telemetry E2E (local node-api → live API)
# Lab install with a private/self-signed CA: trust it instead of disabling TLS checks
$env:NODE_EXTRA_CA_CERTS='C:\certs\platform-ca.pem'
$env:PLATFORM_URL='https://platform.example.com'
$env:PROJECT_DOMAIN='example.com'
$env:ADMIN_EMAIL='admin@example.com'
$env:ADMIN_PASSWORD='<your-admin-password>'
node scripts/e2e-sdk-telemetry.mjs
```

## Notes

- `captureConsole()` is safe to use (it no longer recurses through the SDK logger).
- Never set `NODE_TLS_REJECT_UNAUTHORIZED=0`; use `NODE_EXTRA_CA_CERTS` to trust a lab CA. In Kubernetes, mount the CA from a ConfigMap and point `NODE_EXTRA_CA_CERTS` at it.
- Keep `platform-auto-update` suspended while using `local-*` / `:local` image tags.
- Push `examples/sdk-apps/k8s` to `main` so Argo self-heals without re-applying manifests.

## Configuration and CI

`PLATFORM_URL` is the API origin (no `/api` suffix); `PROJECT_DOMAIN` is the base
hostname used to register project ingress hosts. Both are required before the Node
demo or any `scripts/e2e-sdk-*.mjs` script starts. Use your VM's address/domain,
for example `https://api.<your-ip>.sslip.io` and `<your-ip>.sslip.io`.
The browser demos call the local Node demo; they need no platform credentials.
E2E scripts additionally require `ADMIN_EMAIL` and `ADMIN_PASSWORD` for your VM.
Install dependencies and build `sdk-node` first. GitOps E2E also requires authenticated
`gh` and git; `GH_OWNER` defaults to the authenticated GitHub user. Each script accepts
these environment variables without source changes:

```bash
export PLATFORM_URL=https://platform.example.com
export PROJECT_DOMAIN=example.com
export ADMIN_EMAIL=admin@example.com
export ADMIN_PASSWORD='<your-admin-password>'
node scripts/e2e-sdk-live.mjs
node scripts/e2e-sdk-telemetry.mjs
node scripts/e2e-sdk-gitops.mjs
```

`PLATFORM_API_URL` remains a legacy alias for `PLATFORM_URL` in E2E and deployment
scripts. `DOMAIN` remains a legacy alias for `PROJECT_DOMAIN` in the VPS deployment
helper. Explicit `PLATFORM_URL`/`PROJECT_DOMAIN` take precedence. The deployment
helper substitutes the API origin into the manifest independently of project DNS.
`scripts/vps-verify-roll.sh` requires `PLATFORM_URL` and `PORTAL_URL`.
The one-off `vps-apply-project-ingress.sh`, `vps-fix-tls-hsts.sh` and
`vps-fixup-sdk-apps.sh` repairs for timestamp-named development projects have been
removed; deploy the current manifests with `vps-deploy-sdk-apps.sh` instead.

Run `node scripts/check-server-addresses.mjs` from the repository to scan tracked
working-tree files. CI runs this guard on every push and pull request. Add one
JavaScript regex per line to `scripts/server-address-denylist.txt`, or supply an
additional file via `SERVER_ADDRESS_DENYLIST` or a command-line argument. Additional
lists always extend the built-in list. Run its regression tests and the configuration
checks with `node --test scripts/tests/server-addresses.test.mjs scripts/tests/sdk-config.test.mjs`.
The changed SDK/MCP doc pages are mirrored in the portal and checked for equality.
