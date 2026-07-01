# Kubernetes Infrastructure

## Cluster Architecture

```
┌────────────────────────────────────────────────────────────────────────────┐
│                       k3s Kubernetes Cluster                              │
│                    (single-node, embedded etcd)                            │
│                                                                            │
│  ┌──────────────┐  ┌──────────────────────────────────────────────────┐  │
│  │  Host        │  │                   kube-system                    │  │
│  │  Network     │  │  ┌──────────┐ ┌──────────┐ ┌──────────────────┐ │  │
│  │              │  │  │ coredns  │ │ metrics- │ │ local-path-      │ │  │
│  │  148.113.    │  │  │          │ │ server   │ │ provisioner      │ │  │
│  │  58.205      │  │  └──────────┘ └──────────┘ └──────────────────┘ │  │
│  └──────┬───────┘  └──────────────────────────────────────────────────┘  │
│         │                                                                │
│         │          ┌──────────────────────────────────────────────────┐  │
│         │          │              Platform Namespaces                 │  │
│         │          │                                                  │  │
│         │          │  ┌─────────┐ ┌──────────┐ ┌─────────────┐      │  │
│         │          │  │ caps    │ │cert-     │ │ingress-nginx│      │  │
│         │          │  │         │ │manager   │ │             │      │  │
│         │          │  └─────────┘ └──────────┘ └─────────────┘      │  │
│         │          │  ┌─────────┐ ┌──────────┐ ┌─────────────┐      │  │
│         │          │  │monitoring│ │  loki    │ │   minio     │      │  │
│         │          │  │(grafana, │ │          │ │             │      │  │
│         │          │  │prometheus│ │          │ │             │      │  │
│         │          │  └─────────┘ └──────────┘ └─────────────┘      │  │
│         │          │  ┌─────────┐ ┌──────────┐ ┌─────────────┐      │  │
│         │          │  │ argocd  │ │portainer │ │   mongo     │      │  │
│         │          │  │         │ │          │ │             │      │  │
│         │          │  └─────────┘ └──────────┘ └─────────────┘      │  │
│         │          │  ┌─────────┐ ┌──────────┐                     │  │
│         │          │  │  redis  │ │ postgres │                     │  │
│         │          │  │         │ │          │                     │  │
│         │          │  └─────────┘ └──────────┘                     │  │
│         │          └──────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────┘
```

## Namespace Layout

| Namespace | Purpose | Services | Ingress |
|-----------|---------|----------|---------|
| **caps** | Platform control plane | `api-service`, `portal-service` | `/`, `/api` |
| **cert-manager** | SSL certificate management | `cert-manager`, `cert-manager-webhook`, `cert-manager-cainjector` | None |
| **ingress-nginx** | Ingress controller | `ingress-nginx-controller` (host network) | All inbound traffic |
| **monitoring** | Observability stack | `grafana`, `prometheus`, `kube-state-metrics` | `/grafana` |
| **loki** | Log aggregation | `loki`, `loki-canary` | None (API forwards directly) |
| **minio** | Object storage | `minio` | None (internal) |
| **argocd** | GitOps continuous delivery | `argocd-server`, `argocd-repo-server`, `argocd-redis`, `argocd-application-controller` | `/argocd` |
| **portainer** | Container management UI | `portainer` | `/portainer` |
| **mongo** | MongoDB (logs/metrics) | `mongodb` | None (internal) |
| **redis** | Cache (available, not actively used) | `redis` | None (internal) |
| **postgres** | PostgreSQL (primary data store) | `postgres` | None (internal) |

## Helm Chart Versions

| Component | Chart | Version (as deployed) | Source |
|-----------|-------|-----------------------|--------|
| **cert-manager** | `jetstack/cert-manager` | `v1.15.0` | [artifacthub.io](https://artifacthub.io/packages/helm/cert-manager/cert-manager) |
| **ingress-nginx** | `ingress-nginx/ingress-nginx` | `4.11.0` | [artifacthub.io](https://artifacthub.io/packages/helm/ingress-nginx/ingress-nginx) |
| **Grafana** | `grafana/grafana` | `8.3.0` | [artifacthub.io](https://artifacthub.io/packages/helm/grafana/grafana) |
| **Prometheus** | `prometheus-community/kube-prometheus-stack` | `62.0.0` | [artifacthub.io](https://artifacthub.io/packages/helm/prometheus-community/kube-prometheus-stack) |
| **Loki** | `grafana/loki` | `6.10.0` | [artifacthub.io](https://artifacthub.io/packages/helm/grafana/loki) |
| **ArgoCD** | `argo/argo-cd` | `7.3.0` | [artifacthub.io](https://artifacthub.io/packages/helm/argo/argo-cd) |
| **MinIO** | `bitnami/minio` | `14.6.0` | [artifacthub.io](https://artifacthub.io/packages/helm/bitnami/minio) |
| **Portainer** | `portainer/portainer` | `1.0.65` | [artifacthub.io](https://artifacthub.io/packages/helm/portainer/portainer) |
| **MongoDB** | `bitnami/mongodb` | `15.6.0` | [artifacthub.io](https://artifacthub.io/packages/helm/bitnami/mongodb) |
| **Redis** | `bitnami/redis` | `20.6.0` | [artifacthub.io](https://artifacthub.io/packages/helm/bitnami/redis) |
| **PostgreSQL** | `bitnami/postgresql` | `15.5.0` | [artifacthub.io](https://artifacthub.io/packages/helm/bitnami/postgresql) |

## Ingress Routing Table

```
                         ┌─────────────────────────────┐
                         │   nginx-ingress-controller   │
                         │   LoadBalancer / HostNetwork │
                         │   148.113.58.205:443         │
                         └──────────────┬──────────────┘
                                        │
              ┌─────────────────────────┼──────────────────────────┐
              │                         │                          │
              ▼                         ▼                          ▼
     ┌────────────────┐      ┌──────────────────┐      ┌──────────────────┐
     │ ingress-caps   │      │ ingress-argocd   │      │ ingress-portainer│
     │ host: *.sslip  │      │ host: *.sslip    │      │ host: *.sslip    │
     └───────┬────────┘      └────────┬─────────┘      └────────┬─────────┘
             │                        │                         │
      ┌──────┴──────┐                 │                         │
      │              │                │                         │
      ▼              ▼                ▼                         ▼
 ┌──────────┐ ┌──────────┐  ┌────────────────┐  ┌──────────────────────┐
 │ portal-  │ │ api-     │  │ argocd-server  │  │  portainer-service   │
 │ service  │ │ service  │  │ :443           │  │  :9000               │
 │ :80      │ │ :3000    │  │ /argocd        │  │  /portainer          │
 └──────────┘ └──────────┘  └────────────────┘  └──────────────────────┘
```

### Ingress Configuration (Platform)

```yaml
# D:\SERVER-automation\platform\templates\k8s\ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: caps-ingress
  namespace: caps
  annotations:
    kubernetes.io/ingress.class: nginx
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  tls:
  - hosts:
    - 148.113.58.205.sslip.io
    secretName: caps-tls
  rules:
  - host: 148.113.58.205.sslip.io
    http:
      paths:
      - path: /api
        pathType: Prefix
        backend:
          service:
            name: api-service
            port:
              number: 3000
      - path: /
        pathType: Prefix
        backend:
          service:
            name: portal-service
            port:
              number: 80
```

### Complete Subpath Mapping

| Subpath | Target Service | Namespace | Port | Notes |
|---------|---------------|-----------|------|-------|
| `/` | `portal-service` | caps | 80 | Angular SPA — serves `index.html`, `try_files $uri /index.html` |
| `/api` | `api-service` | caps | 3000 | Express REST API |
| `/grafana` | `grafana` | monitoring | 3000 | Grafana — subpath configured via `GF_SERVER_ROOT_URL` |
| `/argocd` | `argocd-server` | argocd | 443 | ArgoCD — subpath via `argocd-server` ingress annotation |
| `/portainer` | `portainer` | portainer | 9000 | Portainer UI |
| `/oauth2` | `oauth2-proxy` | caps | 4180 | OAuth2 proxy (Grafana/Portainer SSO) |

## Resource Limits per Namespace

```yaml
# ResourceQuota per critical namespace
apiVersion: v1
kind: ResourceQuota
metadata:
  name: caps-quota
  namespace: caps
spec:
  hard:
    requests.cpu: "1"
    requests.memory: "1Gi"
    limits.cpu: "2"
    limits.memory: "2Gi"
```

| Namespace | CPU Request | CPU Limit | Memory Request | Memory Limit |
|-----------|------------|-----------|---------------|--------------|
| **caps** | 1.0 | 2.0 | 1Gi | 2Gi |
| **monitoring** | 1.0 | 2.0 | 2Gi | 4Gi |
| **argocd** | 0.5 | 1.0 | 512Mi | 1Gi |
| **loki** | 0.5 | 1.0 | 1Gi | 2Gi |
| **minio** | 0.5 | 1.0 | 1Gi | 2Gi |
| **mongo** | 0.5 | 1.0 | 1Gi | 2Gi |
| **postgres** | 0.5 | 1.0 | 512Mi | 1Gi |
| **redis** | 0.2 | 0.5 | 256Mi | 512Mi |
| **ingress-nginx** | 0.2 | 0.5 | 256Mi | 512Mi |
| **cert-manager** | 0.1 | 0.2 | 128Mi | 256Mi |
| **portainer** | 0.2 | 0.5 | 256Mi | 512Mi |

## Storage Classes and PVCs

### Default Storage Class

```yaml
# k3s local-path-provisioner (default)
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: local-path
provisioner: rancher.io/local-path
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Delete
```

### Persistent Volume Claims

| PVC Name | Namespace | Size | Access Mode | Storage Class | Mount Path | Used By |
|----------|-----------|------|-------------|---------------|------------|---------|
| `data-postgres-0` | postgres | 8Gi | ReadWriteOnce | local-path | `/var/lib/postgresql/data` | PostgreSQL |
| `mongodb-data-0` | mongo | 8Gi | ReadWriteOnce | local-path | `/data/db` | MongoDB |
| `minio-data-0` | minio | 10Gi | ReadWriteOnce | local-path | `/data` | MinIO |
| `prometheus-data-0` | monitoring | 8Gi | ReadWriteOnce | local-path | `/prometheus` | Prometheus |
| `loki-data-0` | loki | 10Gi | ReadWriteOnce | local-path | `/var/loki` | Loki |
| `grafana-data-0` | monitoring | 1Gi | ReadWriteOnce | local-path | `/var/lib/grafana` | Grafana |
| `redis-data-0` | redis | 1Gi | ReadWriteOnce | local-path | `/data` | Redis (optional) |

### Example PVC

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: data-postgres-0
  namespace: postgres
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 8Gi
  storageClassName: local-path
```

## Deployment Template

```yaml
# D:\SERVER-automation\platform\templates\k8s\deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app-service
  labels:
    app: app-service
spec:
  replicas: 2
  selector:
    matchLabels:
      app: app-service
  template:
    metadata:
      labels:
        app: app-service
    spec:
      containers:
      - name: app-service
        image: app/my-service:latest
        ports:
        - containerPort: 3000
        livenessProbe:
          httpGet:
            path: /health
            port: 3000
        readinessProbe:
          httpGet:
            path: /health
            port: 3000
        resources:
          limits:
            cpu: 500m
            memory: 512Mi
          requests:
            cpu: 100m
            memory: 128Mi
```

## Service Template

```yaml
# D:\SERVER-automation\platform\templates\k8s\service.yaml
apiVersion: v1
kind: Service
metadata:
  name: app-service
spec:
  selector:
    app: app-service
  ports:
  - port: 3000
    targetPort: 3000
  type: ClusterIP
```

## Key Configuration Notes

### cert-manager ClusterIssuer

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: admin@example.com
    privateKeySecretRef:
      name: letsencrypt-prod-private-key
    solvers:
    - http01:
        ingress:
          class: nginx
```

> Note: The wildcard domain `sslip.io` uses self-signed certs (cert-manager skips because the domain includes IP digits). Only real domains (non-sslip, non-IP) trigger Let's Encrypt provisioning (see `src/routes/sdk.ts:221` — `isRealDomain` check).

### Grafana Subpath Configuration

```ini
# Configured via Helm values or env vars:
GF_SERVER_ROOT_URL=https://148.113.58.205.sslip.io/grafana
GF_SERVER_SERVE_FROM_SUB_PATH=true
```

### ArgoCD Subpath Configuration

```yaml
# argocd-server ingress annotation
nginx.ingress.kubernetes.io/rewrite-target: /argocd
nginx.ingress.kubernetes.io/ssl-passthrough: "true"
```

> See [Network Topology](network-topology.md) for DNS and ingress controller details, and [Overview](overview.md) for the high-level system architecture.
