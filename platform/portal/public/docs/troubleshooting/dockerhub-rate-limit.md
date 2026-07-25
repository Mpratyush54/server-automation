# `toomanyrequests: You have reached your pull rate limit`

## Symptom

During the bootstrap, one of the Bitnami / Grafana / Loki chart pulls fails with:

```
Error response from daemon: toomanyrequests: You have reached your pull rate limit.
You may increase the limit by authenticating and upgrading:
  https://www.docker.com/increase-rate-limit
```

Pods stay in `ImagePullBackOff` even though the image name is correct.

## Root Cause

Docker Hub rate-limits **anonymous** image pulls to 100/6 hours per source IP.
On a shared cloud provider your IP can burn through that in a single bootstrap
if you're the second or third install on the same NAT egress.

The Bitnami charts, Grafana, Loki and Prometheus images all live on Docker Hub,
so the whole cluster is affected.

## Fix

### 1. Authenticate to Docker Hub (raises the limit to 200/6 hours)

Create a free Docker Hub account, then on the server:

```bash
docker login
# Login with your Docker Hub username + a Personal Access Token
```

For k3s / containerd (which is what the pods actually use), also drop the
credentials into containerd's registry config:

```bash
sudo mkdir -p /etc/rancher/k3s
sudo tee /etc/rancher/k3s/registries.yaml > /dev/null <<'YAML'
configs:
  "docker.io":
    auth:
      username: <your-docker-hub-user>
      password: <your-docker-hub-personal-access-token>
YAML

sudo systemctl restart k3s
```

### 2. Mirror through GHCR (best for real production)

Every Bitnami image is mirrored to `ghcr.io/bitnami/*`. In Helm values, swap the
repository — for example for MinIO:

```yaml
image:
  repository: ghcr.io/bitnami/minio
console:
  image:
    repository: ghcr.io/bitnami/minio-object-browser
```

The stock bootstrap already uses `bitnamilegacy/*` mirrors for MinIO; you can
apply the same pattern to Postgres, Mongo and Redis if you keep hitting the limit.

### 3. Retry the failed pulls

```bash
kubectl -n <namespace> rollout restart deployment/<name>
# or force the containerd cache to re-fetch:
sudo k3s crictl pull docker.io/bitnami/postgresql:16
```

## Verification

```bash
kubectl get pods -A | grep -v Running | grep -v Completed
```

Empty output (except real errors you already knew about) means the pulls
succeeded.
