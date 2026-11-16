# Find the fix for an error

This page helps you find the fix for an error you hit while installing or running Cairn. Most fixes run on the server with `platformctl` or `kubectl`.

## Start here

1. Run `sudo platformctl status` on the server. It shows which part is broken.
2. Broken passwords, certificates or sign-in? Go to [Recover a broken install](../operations/recover.md).
3. Otherwise, find the message you see below. Each page shows the symptom, the cause and the fix.

Not listed? Read the step logs in `/var/log/platformctl/`, or open an issue at <https://github.com/Mpratyush54/SERVER-automation/issues>.

## Install

| You see | Fix |
|---|---|
| `apt` hangs at "Waiting for cache lock" | [apt lock](apt-lock.md) |
| `TLS handshake timeout` when downloading charts or images | [DNS or IPv6 timeout](dns-ipv6-timeout.md) |
| Names do not resolve inside the cluster | [DNS resolution](general-dns-resolution.md) |
| A `*.sslip.io` name does not resolve inside the cluster | [sslip.io inside the cluster](sslip-io-dns.md) |
| k3s does not start; port 6443, 80 or 443 is in use | [k3s port conflict](k3s-port-conflict.md) |
| `toomanyrequests` when pulling images | [Docker Hub rate limit](dockerhub-rate-limit.md) |
| Pods are evicted; the node reports `DiskPressure=True` | [Disk pressure](disk-pressure.md) |
| GitHub Releases answers 502 or 504 during the install | [GitHub Releases is down](github-releases-outage.md) |
| `ImagePullBackOff` on the API or portal | [ImagePullBackOff](image-pull-backoff.md) |
| `cannot re-use a name that is still in use` | [Helm name in use](helm-name-reuse.md) |
| TypeScript errors while building the API | [TypeScript build errors](typescript-build-errors.md) |

## Ingress, HTTPS and sign-in

| You see | Fix |
|---|---|
| The Let's Encrypt certificate never becomes ready | [cert-manager timeout](cert-manager-timeout.md) |
| The ingress controller refuses a second ingress for the same host | [Ingress ownership](ingress-ownership.md) |
| Portainer shows "Administrator initialization timeout" | [Portainer setup token](portainer-setup-token.md) |
| Portainer sign-in fails with `tls: failed to verify certificate` | [Portainer OIDC certificate](portainer-oidc-ssl.md) |
| Argo CD returns 404 at `/argocd` | [Argo CD returns 404](argocd-subpath-404.md) |
| Argo CD sign-in shows `Invalid redirect URL` | [Argo CD sign-in redirect](argocd-oidc-redirect.md) |
| Grafana redirects in a loop at `/grafana` | [Grafana redirect](grafana-subpath-redirect.md) |

## Databases and storage

| You see | Fix |
|---|---|
| The object storage Helm chart fails with `has no value` | [MinIO template error](minio-template-error.md) |
| The object storage volume stays `Pending` | [MinIO volume not found](minio-pvc-not-found.md) |
| A validation error from the document database when the API starts | [MongoDB validation](mongodb-validation.md) |
| `WRONGPASS` or a wrong password after rotating a database password | [Wrong password after rotate](db-wrongpass-after-rotate.md) |

## API and portal

| You see | Fix |
|---|---|
| The install's seed step fails with `Failed to obtain auth token for seeding` | [API seed failure](api-seed-failure.md) |
| An Angular template fails to compile because of an `@` sign | [Angular @ in templates](angular-template-at-symbol.md) |
