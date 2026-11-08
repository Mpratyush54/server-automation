# Platform stack

Everything a server needs besides `platformctl` and the platform's own API and
portal images ships as one artifact on our registry:

```
ghcr.io/mpratyush54/platform-stack:<YYYY.MM.DD-run>-<arch>
```

It contains every third-party image (PostgreSQL, MongoDB, Redis, MinIO,
Grafana, Prometheus, Loki, Argo CD, ingress-nginx, cert-manager, Portainer,
...), every pinned Helm chart and k3s (binary, install script, airgap images),
plus `stack.json` describing the contents. Each file is a separate layer.

## How installs use it

`platformctl provision` downloads the stack from GHCR while the prerequisites
install. The small base files (k3s, charts) come first, so k3s starts while the
image archives are still downloading. Each archive is imported into k3s'
containerd as soon as it arrives. No component pulls from Docker Hub, quay.io
or GitHub Releases during the install, and nothing depends on GitHub Releases
being up.

Measured on a fresh 4 vCPU / 16 GB VM with a 125 MB/s gp3 disk: **4m52s** from
`provision` to a working platform with a valid Let's Encrypt certificate (it
was about 12-15 minutes before the stack). The download itself varies by
10-15 s between runs.

If the stack cannot be downloaded, the install continues and fetches images,
charts and k3s individually, exactly as before.

| Setting | Effect |
|---|---|
| `PLATFORM_STACK` unset or `stable` | install the `stable` channel (default) |
| `PLATFORM_STACK=edge` | latest stack built from `master` |
| `PLATFORM_STACK=2026.11.08-4` | an exact stack version |
| `PLATFORM_STACK=off` | no stack: individual downloads |
| `--bundle <path\|auto>` | offline bundle instead of the stack |

Each server records the stack it installed (tag, manifest digest, version) in
`/var/lib/platform/stack/installed.json`.

## Publishing and updating it

`.github/workflows/publish-stack.yml` builds it with `scripts/build-stack.sh`
for amd64 and arm64:

- A push to `master` that changes pinned versions, the image list or chart
  values publishes a new stack and moves the `edge` channel.
- **Run the workflow by hand** (Actions → publish platform stack → channel
  `stable`) to publish a stack and make it the one servers install. This is
  independent of `platformctl` releases.

Images a platform does not provide for an architecture are left out of that
architecture's stack (the build logs a warning) and are pulled from their
registry at install time.

The build needs Docker's classic image store; the workflow switches it on.
With the containerd image store, `docker save` exports incomplete images.
