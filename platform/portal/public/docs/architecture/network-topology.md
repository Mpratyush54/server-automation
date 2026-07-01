# Network Topology

## Overall Network Architecture

```
                          INTERNET
                             │
                   ┌─────────▼─────────┐
                   │   148.113.58.205  │
                   │   (Public IP)     │
                   └─────────┬─────────┘
                             │
                   ┌─────────▼─────────┐
                   │   Host Firewall   │
                   │   Open: 80, 443   │
                   │   Closed: all     │
                   │   others          │
                   └─────────┬─────────┘
                             │
                   ┌─────────▼─────────┐
                   │  ingress-nginx    │
                   │  Controller       │
                   │  (hostNetwork:   │
                   │   true)           │
                   │  Ports:           │
                   │   80 → redirect   │
                   │   443 → TLS       │
                   └─────────┬─────────┘
                             │
          ┌──────────────────┼──────────────────┐
          │                  │                  │
          ▼                  ▼                  ▼
   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
   │  caps        │  │  monitoring  │  │  argocd/     │
   │  (portal +   │  │  (grafana,   │  │  portainer   │
   │   api)       │  │   prometheus)│  │  etc.        │
   └──────────────┘  └──────────────┘  └──────────────┘
          │
          ├──────────► postgres-service:5432
          ├──────────► mongo-service:27017
          ├──────────► redis-service:6379
          ├──────────► minio-service:9000
          └──────────► loki-service:3100
```

## Ingress Controller: nginx-ingress on Host Network

```yaml
# Helm values for ingress-nginx
controller:
  hostNetwork: true
  kind: DaemonSet
  service:
    type: ClusterIP  # or LoadBalancer
  publishService:
    enabled: false
  config:
    use-forwarded-headers: "true"
    compute-full-forwarded-for: "true"
    proxy-buffer-size: "128k"
    ssl-redirect: "true"
    force-ssl-redirect: "false"
```

- **Host network mode**: The nginx-ingress controller binds directly to the host's ports 80 and 443, bypassing kube-proxy overhead
- **DaemonSet**: Ensures one pod per node (single-node k3s, so one pod)
- **SSL termination**: All traffic arrives as HTTPS; cert-manager provisions Let's Encrypt certificates

## SSL Termination via cert-manager + Let's Encrypt

```
Client ───► HTTPS :443 ──► nginx-ingress ──► TLS handshake ──► HTTP (in-cluster)
                                    │
                                    │ cert-manager watches
                                    │ Ingress annotations
                                    ▼
                           cert-manager
                                │
                    ┌───────────┴───────────┐
                    │                       │
                    ▼                       ▼
            letsencrypt-prod         letsencrypt-staging
            ClusterIssuer            ClusterIssuer
                    │                       │
                    ▼                       ▼
            Let's Encrypt            Let's Encrypt
            Production API           Staging API
```

**Certificate provisioning flow:**

1. Ingress created with annotation `cert-manager.io/cluster-issuer: letsencrypt-prod`
2. cert-manager creates a `Certificate` resource
3. cert-manager creates an HTTP-01 challenge pod/ingress
4. Let's Encrypt validates domain ownership via HTTP-01
5. Certificate stored in a Kubernetes `Secret` referenced in `ingress.spec.tls[0].secretName`

**Domain-specific behavior** (from `src/routes/sdk.ts:221`):
```typescript
const isRealDomain = !domain.includes('sslip.io') && !domain.match(/^\d+\.\d+\.\d+\.\d+/);
```
- `sslip.io` and IP-based domains: no cert-manager annotation, self-signed or no TLS
- Real domains (e.g., `app.example.com`): full Let's Encrypt provisioning

## Subpath Routing

```
┌─────────────────────────────────────────────────────────────────────┐
│                         REQUEST ROUTING                            │
│                                                                     │
│  https://148.113.58.205.sslip.io/                                   │
│                                    ┌──────────────────────┐        │
│  /          ──────────────────────►│ portal-service:80     │        │
│                                    │ / (Angular SPA)      │        │
│                                    │ try_files $uri        │        │
│                                    │ /index.html           │        │
│                                    └──────────────────────┘        │
│                                                                     │
│                                    ┌──────────────────────┐        │
│  /api/*    ───────────────────────►│ api-service:3000      │        │
│                                    │ /api/*                │        │
│                                    └──────────────────────┘        │
│                                                                     │
│                                    ┌──────────────────────┐        │
│  /argocd/* ───────────────────────►│ argocd-server:443    │        │
│                                    │ (ssl-passthrough)     │        │
│                                    └──────────────────────┘        │
│                                                                     │
│                                    ┌──────────────────────┐        │
│  /portainer/* ────────────────────►│ portainer-service    │        │
│                                    │ :9000                │        │
│                                    └──────────────────────┘        │
│                                                                     │
│                                    ┌──────────────────────┐        │
│  /grafana/* ──────────────────────►│ grafana-service      │        │
│                                    │ :3000 (subpath)      │        │
│                                    └──────────────────────┘        │
└─────────────────────────────────────────────────────────────────────┘
```

### Ingress Rules (Complete)

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: platform-ingress
  namespace: caps
  annotations:
    kubernetes.io/ingress.class: nginx
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    nginx.ingress.kubernetes.io/proxy-body-size: "100m"
spec:
  tls:
  - hosts:
    - 148.113.58.205.sslip.io
    secretName: caps-tls
  rules:
  - host: 148.113.58.205.sslip.io
    http:
      paths:
      # Portal (root)
      - path: /
        pathType: Prefix
        backend:
          service:
            name: portal-service
            port:
              number: 80

      # API
      - path: /api
        pathType: Prefix
        backend:
          service:
            name: api-service
            port:
              number: 3000
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: argocd-ingress
  namespace: argocd
  annotations:
    kubernetes.io/ingress.class: nginx
    nginx.ingress.kubernetes.io/ssl-passthrough: "true"
    nginx.ingress.kubernetes.io/rewrite-target: /argocd
spec:
  rules:
  - host: 148.113.58.205.sslip.io
    http:
      paths:
      - path: /argocd
        pathType: Prefix
        backend:
          service:
            name: argocd-server
            port:
              number: 443
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: portainer-ingress
  namespace: portainer
  annotations:
    kubernetes.io/ingress.class: nginx
spec:
  rules:
  - host: 148.113.58.205.sslip.io
    http:
      paths:
      - path: /portainer
        pathType: Prefix
        backend:
          service:
            name: portainer
            port:
              number: 9000
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: grafana-ingress
  namespace: monitoring
  annotations:
    kubernetes.io/ingress.class: nginx
spec:
  rules:
  - host: 148.113.58.205.sslip.io
    http:
      paths:
      - path: /grafana
        pathType: Prefix
        backend:
          service:
            name: grafana
            port:
              number: 3000
```

## Internal DNS Resolution

```
                            CoreDNS (kube-system)
                                    │
                ┌───────────────────┼───────────────────┐
                │                   │                   │
         ┌──────▼──────┐    ┌───────▼───────┐    ┌──────▼──────┐
         │  Service    │    │  Pod DNS      │    │  External   │
         │  DNS        │    │  (statefulset)│    │  DNS        │
         │             │    │               │    │             │
         │ postgres    │    │ postgres-0    │    │ sslip.io    │
         │ .postgres   │    │ .postgres     │    │             │
         │ .svc.cluster│    │ .svc.cluster  │    │ 148.113.    │
         │ .local      │    │ .local        │    │ 58.205.sslip│
         │             │    │               │    │ .io         │
         └─────────────┘    └───────────────┘    └─────────────┘
```

**Internal DNS naming conventions:**

| Service | DNS Name (in-cluster) | Resolves To |
|---------|----------------------|-------------|
| PostgreSQL | `postgres.postgres.svc.cluster.local` | ClusterIP 10.43.x.x |
| MongoDB | `mongodb.mongo.svc.cluster.local` | ClusterIP 10.43.x.x |
| Redis | `redis.redis.svc.cluster.local` | ClusterIP 10.43.x.x |
| MinIO | `minio.minio.svc.cluster.local` | ClusterIP 10.43.x.x |
| Loki | `loki.loki.svc.cluster.local` | ClusterIP 10.43.x.x |
| API | `api-service.caps.svc.cluster.local` | ClusterIP 10.43.x.x |

**In-cluster API configuration** (`src/server.ts` uses env vars):
```env
POSTGRES_HOST=postgres.postgres.svc.cluster.local
MONGODB_URI=mongodb://mongodb.mongo.svc.cluster.local:27017/platform
REDIS_HOST=redis.redis.svc.cluster.local
LOKI_URL=http://loki.loki.svc.cluster.local:3100
```

## External DNS: sslip.io Wildcard

The server's public IP `148.113.58.205` is used with the `sslip.io` wildcard DNS service:

```
*.148.113.58.205.sslip.io  →  A record →  148.113.58.205
```

This allows multiple subdomain-based services without managing real DNS records:

| Domain | Resolves To | Service |
|--------|------------|---------|
| `148.113.58.205.sslip.io` | `148.113.58.205` | Root — Portal |
| `api.148.113.58.205.sslip.io` | `148.113.58.205` | API (if separated) |
| `*.148.113.58.205.sslip.io` | `148.113.58.205` | Wildcard — SDK auto-created services |

**SDK auto-created Ingress domains** (`src/routes/sdk.ts:232`):
```typescript
const domain = project.domain || process.env.DOMAIN || 'sslip.io';
// Resulting host: {serviceName}.{domain}
// e.g. "my-app.148.113.58.205.sslip.io"
```

## systemd-resolved Configuration

To ensure reliable DNS resolution within the k3s cluster, `systemd-resolved` is configured on the host:

```ini
# /etc/systemd/resolved.conf
[Resolve]
DNS=1.1.1.1 8.8.8.8
FallbackDNS=8.8.4.4
Domains=~.
DNSSEC=allow-downgrade
DNSOverTLS=opportunistic
Cache=yes
DNSStubListener=yes
```

**Key settings:**
- Primary DNS: Cloudflare (1.1.1.1) + Google (8.8.8.8)
- `Domains=~.`: Route all queries through these DNS servers (prevents search domain leakage)
- `DNSOverTLS=opportunistic`: Encrypt DNS queries when the upstream supports it
- `Cache=yes`: Local DNS caching reduces latency

**Troubleshooting DNS issues:**
```bash
# Check resolved status
resolvectl status

# Flush cache
resolvectl flush-caches

# Test resolution
resolvectl query 148.113.58.205.sslip.io

# Check k3s CoreDNS
kubectl -n kube-system logs -l k8s-app=kube-dns --tail=50
```

**Common DNS issues & fixes** (see [troubleshooting docs](../troubleshooting/)):
| Issue | Cause | Fix |
|-------|-------|-----|
| IPv6 DNS timeout | AAAA queries to non-IPv6 networks | `sysctl -w net.ipv6.conf.all.disable_ipv6=1` |
| CoreDNS loop | systemd-resolved interference | Set `Domains=~.` in resolved.conf |
| cert-manager timeout | DNS propagation delay | Check `dig` resolution, increase `ACME` timeout |

## Network Policies (Future Consideration)

Currently no `NetworkPolicy` resources are enforced. The cluster relies on:
- **Namespace isolation** (logical, not network-enforced)
- **Service-based access** (only explicit connections through service DNS)
- **Ingress-only external access** (no `NodePort` or `LoadBalancer` exposed besides ingress)

Recommended future network policies:
```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: api-allow-ingress-only
  namespace: caps
spec:
  podSelector:
    matchLabels:
      app: api-service
  policyTypes:
  - Ingress
  ingress:
  - from:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: ingress-nginx
    ports:
    - protocol: TCP
      port: 3000
```

## Port Summary

| Service | Protocol | Port | Source | Destination | Purpose |
|---------|----------|------|--------|-------------|---------|
| **HTTP** | TCP | 80 | Internet | Host | Redirect to 443 |
| **HTTPS** | TCP | 443 | Internet | Host → Ingress | All web traffic |
| **Ingress metrics** | TCP | 10254 | Internal | Ingress | Prometheus scraping |
| **PostgreSQL** | TCP | 5432 | API pod | PostgreSQL pod | Data store |
| **MongoDB** | TCP | 27017 | API pod | MongoDB pod | Logs/metrics |
| **Redis** | TCP | 6379 | API pod | Redis pod | Cache |
| **MinIO API** | TCP | 9000 | API pod | MinIO pod | File storage |
| **MinIO Console** | TCP | 9001 | Internal | MinIO pod | Admin UI |
| **Loki** | TCP | 3100 | API pod | Loki pod | Log aggregation |
| **Grafana** | TCP | 3000 | Ingress | Grafana pod | Dashboards |
| **ArgoCD** | TCP | 443 | Ingress | ArgoCD pod | GitOps UI |
| **Portainer** | TCP | 9000 | Ingress | Portainer pod | Container mgmt |
| **OAuth2 Proxy** | TCP | 4180 | Ingress | OAuth2 proxy | SSO |

> See [K8s Infrastructure](k8s-infrastructure.md) for Helm chart versions and resource limits, and [Overview](overview.md) for the high-level system diagram.
