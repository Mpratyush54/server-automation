# `ImagePullBackOff` / `ErrImagePull` on `platform-api` or `platform-portal`

## Symptom

```
kubectl get pods -n platform
NAME                              READY   STATUS             RESTARTS   AGE
platform-api-6d7c9f8-abc          0/1     ImagePullBackOff   0          3m
platform-portal-59f8bd4-def       0/1     ErrImagePull       0          3m
```

Describe shows:

```
Failed to pull image "ghcr.io/your-org/platform-api:latest":
  rpc error: not found
```

## Root Cause

The Kubernetes Deployment references a container image that doesn't exist in the
registry. The two ways this happens:

1. **Placeholder registry** — an older `bootstrap.sh` hardcoded
   `ghcr.io/your-org/platform-api` in the Deployment manifest. Fixed on master, but
   an installed cluster may still have the stale Deployment.
2. **Fork without a published image** — you cloned the repo, changed
   `PLATFORM_IMAGE_REGISTRY` to your own user, but haven't published images to
   that GHCR namespace yet.

## Fix

### 1. Verify what image the Deployment is actually asking for

```bash
kubectl get deploy -n platform platform-api  -o jsonpath='{.spec.template.spec.containers[0].image}'; echo
kubectl get deploy -n platform platform-portal -o jsonpath='{.spec.template.spec.containers[0].image}'; echo
```

If either says `ghcr.io/your-org/...`, you have the stale Deployment.

### 2. Point at the published images

Stock images live at `ghcr.io/mpratyush54/platform-api:latest` and
`ghcr.io/mpratyush54/platform-portal:latest`:

```bash
kubectl set image -n platform deploy/platform-api    api=ghcr.io/mpratyush54/platform-api:latest
kubectl set image -n platform deploy/platform-portal portal=ghcr.io/mpratyush54/platform-portal:latest
```

Or re-run the bootstrap, which now writes the correct image path:

```bash
# force phase 15 to re-run
sudo sed -i '/^platform=/d' /etc/platform/.bootstrap_state
sudo ./platform-bootstrap/bootstrap.sh
```

### 3. If you're running your own fork

Publish your images and set the registry env var before running the bootstrap:

```bash
export PLATFORM_IMAGE_REGISTRY=ghcr.io/<your-github-user>
export PLATFORM_IMAGE_TAG=latest
sudo -E ./bootstrap.sh
```

The stock CI workflow (`.github/workflows/publish-packages.yml`) publishes images
on every push to `master` and every semver tag.

### 4. Private registry? Add an imagePullSecret

If your fork's GHCR namespace is private:

```bash
kubectl create secret docker-registry ghcr-cred \
  --namespace=platform \
  --docker-server=ghcr.io \
  --docker-username=<user> \
  --docker-password=<personal-access-token>

kubectl patch deployment platform-api -n platform \
  -p '{"spec":{"template":{"spec":{"imagePullSecrets":[{"name":"ghcr-cred"}]}}}}'
kubectl patch deployment platform-portal -n platform \
  -p '{"spec":{"template":{"spec":{"imagePullSecrets":[{"name":"ghcr-cred"}]}}}}'
```

## Verification

```bash
kubectl rollout status deployment/platform-api    -n platform
kubectl rollout status deployment/platform-portal -n platform
```

Both should reach `deployment "..." successfully rolled out`.
