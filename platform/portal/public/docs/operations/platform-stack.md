# What the installer downloads

This page explains the single download that holds every third-party component Cairn installs, and how to choose which version a server gets. You control it with the `PLATFORM_STACK` setting when you run `platformctl provision`; there is nothing to set in the portal.

## Choose a version

By default a new server installs the `stable` stack. To pick another, set `PLATFORM_STACK` before you provision:

```sh
sudo PLATFORM_STACK=2026.11.08-4 platformctl provision
```

| Setting | Effect |
|---|---|
| `PLATFORM_STACK` unset or `stable` | The `stable` channel (default). |
| `PLATFORM_STACK=edge` | The newest stack built from the `master` branch. |
| `PLATFORM_STACK=2026.11.08-4` | One exact stack version. |
| `PLATFORM_STACK=off` | No stack: download each image, chart and k3s separately. |
| `--bundle <path\|auto>` | Use an offline bundle instead of the stack. |

To see which stack a server installed:

```sh
sudo cat /var/lib/platform/stack/installed.json
```

It records the tag, the manifest digest and the stack version.

## Why it is faster

The installer starts downloading the stack while it installs the base packages. Small files (k3s and the charts) come first, so k3s starts while the larger image files are still downloading. Each image is loaded as soon as it arrives. Nothing is pulled from Docker Hub, quay.io or GitHub Releases during the install, so their rate limits and outages do not matter.

On a fresh 4 vCPU, 16 GB server with a 125 MB/s disk, a full install with a valid Let's Encrypt certificate took 4 minutes 52 seconds, compared with about 12 to 15 minutes before. The download time varies by 10 to 15 seconds between runs.

If the stack cannot be downloaded, the install continues and fetches each image, chart and k3s separately.

## How it works

The stack is one OCI artifact (a container-registry package) on GitHub's container registry:

```
ghcr.io/mpratyush54/platform-stack:<YYYY.MM.DD-run>-<arch>
```

Channel tags are `stable-<arch>` and `edge-<arch>`. It contains every third-party image (PostgreSQL, MongoDB, Redis, MinIO, Grafana, Prometheus, Loki, Argo CD, ingress-nginx, cert-manager, Portainer and others), every pinned Helm chart, and k3s (binary, install script and airgap images), plus `stack.json` describing the contents. Each file is a separate layer. The Cairn API and portal images are not part of it.

On the server:

- Image archives go to `/var/lib/rancher/k3s/agent/images` and are imported into k3s's container runtime.
- Charts go to `/var/lib/platform/charts`.
- The k3s binary, its install script and `stack.json` are staged in `/var/lib/platform/stack`.

### Publishing a stack (maintainers)

`.github/workflows/publish-stack.yml` builds it with `scripts/build-stack.sh` for amd64 and arm64. Stacks are versioned separately from `platformctl` releases.

- A push to `master` that changes pinned versions, the image list, chart values or the build scripts publishes a new stack and moves the `edge` channel.
- To publish a stack and make it the one servers install, run the workflow by hand (Actions, "publish platform stack", channel `stable`).
- An image that has no build for one architecture is left out of that architecture's stack (the build logs a warning) and is pulled from its registry during the install.
- The build needs Docker's classic image store; the workflow turns it on. With the containerd image store, `docker save` exports incomplete images.
