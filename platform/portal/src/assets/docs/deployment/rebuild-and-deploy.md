# Rebuild & Deploy Workflow

After changing the Platform API or portal, **build in GitHub Actions** — do not compile on the server.

## Production path (recommended)

1. Push to `master` (publishes `:latest`) or tag `vX.Y.Z` (publishes semver + releases `platformctl`).
2. Workflow [`.github/workflows/docker-build.yml`](../../.github/workflows/docker-build.yml) builds **linux/amd64 + linux/arm64** and pushes:
   - `ghcr.io/mpratyush54/platform-api:<tag>`
   - `ghcr.io/mpratyush54/platform-portal:<tag>`
3. On the server, roll the deployments (no local `docker build`):

```bash
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
TAG=latest   # or 1.2.3 from a release

kubectl set image -n platform deploy/platform-api \
  api=ghcr.io/mpratyush54/platform-api:$TAG
kubectl set image -n platform deploy/platform-portal \
  portal=ghcr.io/mpratyush54/platform-portal:$TAG

kubectl rollout status -n platform deploy/platform-api
kubectl rollout status -n platform deploy/platform-portal
```

Or re-run the platform phase:

```bash
sudo sed -i '/^platform=/d' /etc/platform/.bootstrap_state
sudo PLATFORM_IMAGE_TAG=$TAG platformctl install platform
```

## Prerequisites

- Cluster already provisioned with `platformctl provision`
- `kubectl` / `KUBECONFIG=/etc/rancher/k3s/k3s.yaml`

## Update secrets (if env vars changed)

```bash
# Prefer re-running provision after editing /etc/platform/.env, or:
kubectl create secret generic platform-env \
  --namespace platform \
  --from-literal=PLATFORM_NAME="Your Platform" \
  --dry-run=client -o yaml | kubectl apply -f -
```

## Verification

```bash
kubectl get pods -n platform
kubectl logs -n platform deploy/platform-api --tail=50
curl -sf http://127.0.0.1/api/health || curl -sf https://YOUR_DOMAIN/api/health
```

## Local image build (dev only)

Only for laptop debugging — **not** for production servers:

```bash
docker build -t ghcr.io/mpratyush54/platform-api:dev platform/api
docker build -t ghcr.io/mpratyush54/platform-portal:dev platform/portal
```

Prefer pushing a branch and letting CI produce the multi-arch images.
