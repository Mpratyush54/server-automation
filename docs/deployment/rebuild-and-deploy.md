# Ship a change to the Cairn API or portal

This page is for people who change Cairn's own code (the API or the portal) and want that change running on a server. You build the images in GitHub Actions and roll them out on the server with `platformctl`; nothing is compiled on the server.

To move a server to a published release instead, use [Upgrade Cairn to a new release](../operations/upgrades.md).

## Ship it

1. Push your change to `master`, or push a tag such as `v1.4.0`. GitHub Actions builds the API and portal images for amd64 and arm64 and publishes them.
2. On the server, pull the new images and restart the API and portal:

   ```bash
   sudo platformctl update
   ```

   This uses the image tag in `/etc/platform/.env` (`PLATFORM_IMAGE_TAG`, usually `latest`). To roll out a specific tag once:

   ```bash
   sudo PLATFORM_IMAGE_TAG=1.4.0 platformctl update
   ```

3. Check it:

   ```bash
   sudo kubectl get pods -n platform
   curl -sf https://platform.example.com/api/health
   ```

`update` backs up the platform database, runs database migrations, then rolls the two deployments to the new images, pinned by digest.

## Image tags

| You push | Tags published |
|---|---|
| A commit to `master` | `latest` and `master` |
| A tag `v1.4.0` | `1.4.0` and `1.4` (and the `platformctl` release) |

Images: `ghcr.io/mpratyush54/platform-api:<tag>` and `ghcr.io/mpratyush54/platform-portal:<tag>`.

## Changed a setting

Edit `/etc/platform/.env`, then re-apply the platform step so the API and portal get the new settings:

```bash
sudo platformctl install platform
```

## Build an image on your laptop

Only for local debugging, never for a production server:

```bash
docker build -t ghcr.io/mpratyush54/platform-api:dev platform/api
docker build -t ghcr.io/mpratyush54/platform-portal:dev platform/portal
```

Prefer pushing a branch and letting CI build the images.

## How it works

- The workflow is [`.github/workflows/docker-build.yml`](https://github.com/Mpratyush54/SERVER-automation/blob/master/.github/workflows/docker-build.yml). Pushes to `master` and tags `v*.*.*` publish multi-arch images to GHCR (GitHub's container registry). Pull requests and other branches build, but tags are named after the branch or PR.
- `platformctl update` moves host state into Kubernetes Secrets, checks that both images exist, takes a database backup under `/var/lib/platform/backups`, runs the `platform-api-migrate` Job, then sets the Deployment images by digest. On offline installs it uses images already imported on the node.
- The API does not run migrations when it starts. That is why you should not change the images with `kubectl set image` alone: the new API can start against an old schema. If you must, run `sudo platformctl update` afterwards so migrations run.
- `platformctl install platform` re-applies the platform Secrets, RBAC and Deployments from `/etc/platform/.env`. It runs even if the install marked the step as done; you do not need to edit `/etc/platform/.bootstrap_state`.
- Logs: `sudo kubectl logs -n platform deploy/platform-api --tail=50`.
