# Rebuild & Deploy Workflow

After making code changes to the platform API or portal, use this workflow to rebuild Docker images and update the k3s cluster. This follows the same approach as `platform-bootstrap/bootstrap.sh` (Phase 15).

## Prerequisites

- Docker installed on the build machine
- `kubectl` configured to point to the k3s cluster (`KUBECONFIG=/etc/rancher/k3s/k3s.yaml`)
- Build context accessible (the repo root with `platform/api/` and `platform/portal/`)

> **Don't use `docker compose`** for production deployments — the bootstrap.sh workflow uses direct `docker build` + `docker save` + `k3s ctr images import` because k3s runs containerd, not Docker.

---

## 1. Build Docker Image (API)

```bash
# From the repo root
docker build -t platform-api:latest platform/api
```

Docker automatically finds the `Dockerfile` inside the context directory — no need for the `-f` flag.

### With ghcr.io tag (matching the k8s deployment)

```bash
docker build -t ghcr.io/your-org/platform-api:latest platform/api
```

---

## 2. Build Docker Image (Portal)

```bash
docker build -t platform-portal:latest platform/portal
```

> The portal Dockerfile uses a multi-stage build: `node:20-alpine` builder -> `nginx:alpine` runtime.

---

## 3. Save & Import to k3s

k3s uses containerd (not Docker) as its container runtime. Images built with Docker must be saved to a tar file and imported into k3s's containerd image store.

```bash
# Save API image
docker save platform-api:latest -o /tmp/platform-api.tar
k3s ctr images import /tmp/platform-api.tar
rm -f /tmp/platform-api.tar

# Save Portal image
docker save platform-portal:latest -o /tmp/platform-portal.tar
k3s ctr images import /tmp/platform-portal.tar
rm -f /tmp/platform-portal.tar
```

### Verify Import

```bash
k3s ctr images list | grep platform
```

Expected output:
```
docker.io/library/platform-api:latest
docker.io/library/platform-portal:latest
```

> The image gets prefixed with `docker.io/library/` because Docker tags without a registry prefix. If you used a `ghcr.io/your-org/` prefix, it preserves that.

---

## 4. Update Secrets (if env vars changed)

If you added or changed environment variables, update the K8s secret:

```bash
kubectl create secret generic platform-env \
  --namespace platform \
  --from-literal=PLATFORM_NAME="Your Platform" \
  --dry-run=client -o yaml | kubectl apply -f -
```

> Use `--dry-run=client -o yaml | kubectl apply -f -` to avoid the "already exists" error. This creates or updates the secret in place.

For the full secret definition, see `platform-bootstrap/bootstrap.sh` Phase 15's `deploy_platform()` function.

---

## 5. Re-apply Manifests

The bootstrap.sh applies the full YAML manifest (deployments, services, ingresses) on every deploy. If you changed any Kubernetes resource definitions:

```bash
kubectl apply -n platform -f platform/k8s/manifests.yaml
```

If you're only updating the image, skip to step 6.

---

## 6. Restart the Deployment

Trigger a rolling restart to pick up the new image:

```bash
kubectl rollout restart deployment/platform-api -n platform
kubectl rollout restart deployment/platform-portal -n platform
```

> `rollout restart` forces new pods even with `imagePullPolicy: IfNotPresent`. Required because the image tag stays `latest`.

---

## 7. Monitor Rollout Status

```bash
kubectl rollout status deployment/platform-api -n platform --timeout=300s
kubectl rollout status deployment/platform-portal -n platform --timeout=300s
```

### Watch Pod Transitions

```bash
kubectl get pods -n platform -w
```

---

## 8. Verify Deployment

### Health Check

```bash
# Direct cluster IP access
API_IP=$(kubectl get svc -n platform platform-api -o jsonpath='{.spec.clusterIP}')
curl -sf "http://$API_IP:3000/api/health"

# Via ingress (if DNS configured)
curl -sf "https://$DOMAIN/api/health"
```

### Check Pod Logs

```bash
kubectl logs -n platform deployment/platform-api --tail=50
kubectl logs -n platform deployment/platform-portal --tail=50
```

---

## Full One-Liner (Both API + Portal)

```bash
docker build -t platform-api:latest platform/api && \
docker build -t platform-portal:latest platform/portal && \
docker save platform-api:latest -o /tmp/platform-api.tar && \
docker save platform-portal:latest -o /tmp/platform-portal.tar && \
k3s ctr images import /tmp/platform-api.tar && \
k3s ctr images import /tmp/platform-portal.tar && \
rm -f /tmp/platform-api.tar /tmp/platform-portal.tar && \
kubectl rollout restart deployment/platform-api -n platform && \
kubectl rollout restart deployment/platform-portal -n platform && \
kubectl rollout status deployment/platform-api -n platform --timeout=300s && \
kubectl rollout status deployment/platform-portal -n platform --timeout=300s
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Error: image not found` | Image not imported to containerd | Run `k3s ctr images import` and verify with `k3s ctr images list | grep platform` |
| `ErrImageNeverPull` / `ImagePullBackOff` | Wrong image name in deployment | Check `kubectl get deployment platform-api -n platform -o yaml | grep image:` |
| Pod stays `Terminating` | PreStop hook or long shutdown | `kubectl delete pod -n platform <pod-name> --force --grace-period=0` |
| New pod shows old behavior | Image cache stale | Delete the pod entirely: `kubectl delete pod -n platform -l app=platform-api` |
| Rollout timed out | Readiness probe failing | `kubectl describe pod -n platform -l app=platform-api` for events |
| `docker build` fails | Missing dependencies | Check `npm install` output, ensure `node_modules` is not corrupted |
