# Troubleshooting

Every page here is a real issue that came up during an install. If you hit
something not covered, open an issue: <https://github.com/Mpratyush54/SERVER-automation/issues>.

## Install & Bootstrap

- [apt-lock.md](apt-lock.md) — `apt` hangs at "Waiting for cache lock"
- [dns-ipv6-timeout.md](dns-ipv6-timeout.md) — Helm / docker pull `TLS handshake timeout`
- [general-dns-resolution.md](general-dns-resolution.md) — DNS resolution failures inside the cluster
- [sslip-io-dns.md](sslip-io-dns.md) — `*.sslip.io` name won't resolve inside the cluster
- [k3s-port-conflict.md](k3s-port-conflict.md) — k3s fails to start, port 6443/80/443 in use
- [dockerhub-rate-limit.md](dockerhub-rate-limit.md) — `toomanyrequests` on image pulls
- [disk-pressure.md](disk-pressure.md) — pods evicted, node `DiskPressure=True`
- [image-pull-backoff.md](image-pull-backoff.md) — `ImagePullBackOff` on `platform-api` / `platform-portal`
- [helm-name-reuse.md](helm-name-reuse.md) — `cannot re-use a name that is still in use`
- [typescript-build-errors.md](typescript-build-errors.md) — TypeScript build errors during API build

## Ingress, TLS & Auth

- [cert-manager-timeout.md](cert-manager-timeout.md) — Let's Encrypt cert never becomes `Ready=True`
- [ingress-ownership.md](ingress-ownership.md) — nginx-ingress refuses another ingress for the same host
- [portainer-oidc-ssl.md](portainer-oidc-ssl.md) — Portainer OIDC → `tls: failed to verify certificate`
- [portainer-setup-token.md](portainer-setup-token.md) — Portainer "Administrator initialization timeout"
- [argocd-subpath-404.md](argocd-subpath-404.md) — ArgoCD returns 404 when mounted at `/argocd`
- [argocd-oidc-redirect.md](argocd-oidc-redirect.md) — ArgoCD login → `Invalid redirect URL`
- [grafana-subpath-redirect.md](grafana-subpath-redirect.md) — Grafana redirect loop at `/grafana`

## Databases & Storage

- [minio-template-error.md](minio-template-error.md) — MinIO Helm `has no value` error
- [minio-pvc-not-found.md](minio-pvc-not-found.md) — MinIO PVC stuck in `Pending`
- [mongodb-validation.md](mongodb-validation.md) — Mongoose validation error on API startup
- [db-wrongpass-after-rotate.md](db-wrongpass-after-rotate.md) — `WRONGPASS` after rotating a DB password
- [infisical-db-missing.md](infisical-db-missing.md) — Infisical crash-loops with `database "infisical" does not exist`

## API & Seed

- [api-seed-failure.md](api-seed-failure.md) — Bootstrap seed → `Failed to obtain auth token for seeding`
- [angular-template-at-symbol.md](angular-template-at-symbol.md) — Angular template `@` symbol parse error
