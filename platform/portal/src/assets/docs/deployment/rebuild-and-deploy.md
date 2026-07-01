# Rebuild & Deploy Workflow

After making code changes to the platform API or portal, use this workflow to rebuild Docker images and update the k3s cluster.

## Prerequisites

- Docker installed on the build machine
- `kubectl` configured to point to the k3s cluster (`KUBECONFIG=/etc/rancher/k3s/k3s.yaml`)
- Build context accessible (the repo root with `platform/api/` and `platform/portal/`)

---

## 1. Build Docker Image (API)

```bash
# From the repo root
docker build -t platform-api:latest -f platform/api/Dockerfile platform/api
```

> **Note:** The API image uses `node:20-alpine`, runs `npm install`, `npm run build`, and exposes port 3000.

### Build Arguments (if applicable)

```bash
docker build \
  --build-arg NODE_ENV=production \
  -t platform-api:latest \
  -f platform/api/Dockerfile \
  platform/api
```

---

## 2. Build Docker Image (Portal)

```bash
docker build -t platform-portal:latest -f platform/portal/Dockerfile platform/portal
```

> The portal image uses a multi-stage build: `node:20-alpine` builder → `nginx:alpine` runtime, serving Angular static files on port 80.

---

## 3. Save & Import to k3s

k3s uses containerd (not Docker) as its container runtime. Images built with Docker must be saved to a tar file and imported into k3s's containerd image store.

### API

```bash
docker save platform-api:latest -o /tmp/platform-api.tar
k3s ctr images import /tmp/platform-api.tar
rm -f /tmp/platform-api.tar
```

### Portal

```bash
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

> The image will appear as `docker.io/library/platform-api:latest` because Docker tags it without a registry prefix.

---

## 4. Restart the Deployment

Trigger a rolling restart of the Kubernetes deployment to pick up the new image:

```bash
kubectl rollout restart deployment/platform-api -n platform
kubectl rollout restart deployment/platform-portal -n platform
```

> `rollout restart` forces the deployment to create new pods with the latest image even if `imagePullPolicy: IfNotPresent`. This is necessary because the image tag hasn't changed.

---

## 5. Monitor Rollout Status

```bash
kubectl rollout status deployment/platform-api -n platform --timeout=300s
kubectl rollout status deployment/platform-portal -n platform --timeout=300s
```

### Watch Pod Transitions

```bash
kubectl get pods -n platform -w
```

Look for:
```
platform-api-7d4f8b9c5c-abcde   1/1   Running   0  10s
platform-api-7d4f8b9c5c-xyz12   0/1   Terminating   0  5m
```

---

## 6. Verify Deployment

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
# API
kubectl logs -n platform deployment/platform-api --tail=50

# Portal
kubectl logs -n platform deployment/platform-portal --tail=50

# Follow logs
kubectl logs -n platform deployment/platform-api --tail=50 -f
```

### Describe for Details

```bash
kubectl describe deployment/platform-api -n platform
kubectl describe pod -n platform -l app=platform-api
```

---

## Full One-Liner (API only)

```bash
docker build -t platform-api:latest -f platform/api/Dockerfile platform/api && \
docker save platform-api:latest -o /tmp/platform-api.tar && \
k3s ctr images import /tmp/platform-api.tar && \
rm -f /tmp/platform-api.tar && \
kubectl rollout restart deployment/platform-api -n platform && \
kubectl rollout status deployment/platform-api -n platform --timeout=300s
```

---

## Full One-Liner (Both)

```bash
docker build -t platform-api:latest -f platform/api/Dockerfile platform/api && \
docker build -t platform-portal:latest -f platform/portal/Dockerfile platform/portal && \
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
| `Error: image not found` | Image not imported to containerd | Run `k3s ctr images import` and verify with `k3s ctr images list \| grep platform` |
| `ErrImageNeverPull` / `ImagePullBackOff` | Wrong image name in deployment | Check `kubectl get deployment platform-api -n platform -o yaml \| grep image:` |
| Pod stays `Terminating` | PreStop hook or long shutdown | `kubectl delete pod -n platform <pod-name> --force --grace-period=0` |
| New pod shows old behavior | Image cache stale | Delete the pod entirely: `kubectl delete pod -n platform -l app=platform-api` |
| Rollout timed out | Readiness probe failing | `kubectl describe pod -n platform -l app=platform-api` for events |
| `docker build` fails | Missing dependencies | Check `npm install` output, ensure `node_modules` is not corrupted |

## Alternative: Using Image Registry

If you prefer a container registry instead of local import:

```bash
# Tag and push
docker tag platform-api:latest ghcr.io/your-org/platform-api:$(git rev-parse --short HEAD)
docker push ghcr.io/your-org/platform-api:$(git rev-parse --short HEAD)

# Update deployment with new tag
kubectl set image deployment/platform-api -n platform \
  api=ghcr.io/your-org/platform-api:$(git rev-parse --short HEAD)

# Set imagePullPolicy: Always if needed
kubectl patch deployment platform-api -n platform -p \
  '{"spec":{"template":{"spec":{"containers":[{"name":"api","imagePullPolicy":"Always"}]}}}}'
```
