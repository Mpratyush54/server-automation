# Scaling & Resource Management

This document covers resource limits, Horizontal Pod Autoscaling (HPA), node scaling, and monitoring resource usage in the Platform stack.

---

## Resource Limits in Helm Values

### Current Default Limits

Platform components shipped with the following resource requests and limits:

| Component | Request CPU | Request Memory | Limit CPU | Limit Memory |
|---|---|---|---|---|
| Platform API | 250m | 256Mi | 1000m | 1Gi |
| Platform Portal | 50m | 64Mi | 200m | 256Mi |
| PostgreSQL | 250m (default) | 256Mi (default) | — | 20Gi disk |
| MongoDB | 250m (default) | 256Mi (default) | — | 20Gi disk |
| Redis | 100m (default) | 128Mi (default) | — | 8Gi disk |
| MinIO | 250m (default) | 256Mi (default) | — | 50Gi disk |
| Prometheus | 200m | 1Gi | — | 30Gi disk |
| Grafana | 200m | 200Mi | — | — |
| Loki | 200m | 512Mi | — | 20Gi disk |

### Adjusting Limits for Platform Deployments

Edit the deployment YAML and re-apply:

```yaml
# patch-resources.yaml
spec:
  template:
    spec:
      containers:
      - name: api
        resources:
          requests:
            memory: "512Mi"
            cpu: "500m"
          limits:
            memory: "2Gi"
            cpu: "2000m"
```

```bash
kubectl patch deployment platform-api -n platform --patch-file patch-resources.yaml
```

### Adjusting Limits for Bitnami Helm Charts

```bash
helm upgrade --install postgresql bitnami/postgresql \
  --namespace databases \
  --set primary.resources.requests.memory=512Mi \
  --set primary.resources.requests.cpu=500m \
  --set primary.resources.limits.memory=2Gi \
  --set primary.resources.limits.cpu=2000m \
  --set primary.persistence.size=50Gi \
  --reuse-values
```

### Adjusting Prometheus/Grafana Resources

```bash
helm upgrade --install kube-prometheus prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  --set prometheus.prometheusSpec.resources.requests.memory=2Gi \
  --set prometheus.prometheusSpec.resources.requests.cpu=500m \
  --set prometheus.prometheusSpec.resources.limits.memory=4Gi \
  --set prometheus.prometheusSpec.retention=60d \
  --reuse-values
```

---

## Horizontal Pod Autoscaling (HPA)

### Platform API

```bash
# Create HPA for Platform API
kubectl autoscale deployment platform-api -n platform \
  --cpu-percent=75 \
  --min=2 \
  --max=10
```

Verify:

```bash
kubectl get hpa -n platform
# NAME           REFERENCE                 TARGETS   MINPODS   MAXPODS   REPLICAS   AGE
# platform-api   Deployment/platform-api   45%/75%   2         10        2          5m
```

### Platform Portal

```bash
kubectl autoscale deployment platform-portal -n platform \
  --cpu-percent=80 \
  --min=1 \
  --max=5
```

### Custom HPA with Multiple Metrics

```yaml
# api-hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: platform-api
  namespace: platform
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: platform-api
  minReplicas: 2
  maxReplicas: 20
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 80
  - type: Pods
    pods:
      metric:
        name: http_requests_per_second
      target:
        type: AverageValue
        averageValue: 500
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
      - type: Percent
        value: 50
        periodSeconds: 60
    scaleUp:
      stabilizationWindowSeconds: 60
      policies:
      - type: Percent
        value: 100
        periodSeconds: 60
```

```bash
kubectl apply -f api-hpa.yaml
```

### Database HPA

For stateful workloads like databases, use **vertical scaling** (increase resources) rather than horizontal scaling. Most Bitnami charts support `readReplicas` for PostgreSQL for read scaling:

```bash
helm upgrade --install postgresql bitnami/postgresql \
  --namespace databases \
  --set readReplicas.replicaCount=2 \
  --set readReplicas.resources.requests.memory=512Mi \
  --reuse-values
```

> **Warning:** HPA for stateful databases is not recommended. Scale databases vertically by increasing resource limits.

---

## Node Scaling

### Single-Node (k3s Default)

The bootstrap script installs k3s as a single-node cluster. To add worker nodes:

```bash
# On the master node, get the token
NODE_TOKEN=$(sudo cat /var/lib/rancher/k3s/server/node-token)
MASTER_IP=$(hostname -I | awk '{print $1}')

# On each worker node (fresh Ubuntu)
curl -sfL https://get.k3s.io | K3S_URL=https://$MASTER_IP:6443 \
  K3S_TOKEN=$NODE_TOKEN sh -
```

### Verify Node Join

```bash
kubectl get nodes
# NAME         STATUS   ROLES                  AGE   VERSION
# master       Ready    control-plane,master   1d    v1.29.0+k3s1
# worker-01    Ready    <none>                 10m   v1.29.0+k3s1
# worker-02    Ready    <none>                 5m    v1.29.0+k3s1
```

### Taint Management

Control-plane nodes have a taint that prevents workloads from scheduling on them by default. To allow workloads on the control-plane node:

```bash
kubectl taint nodes --all node-role.kubernetes.io/control-plane-  # Remove taint
kubectl taint nodes master node-role.kubernetes.io/control-plane=true:NoSchedule  # Re-add
```

### Node Labels for Workload Scheduling

```bash
# Label nodes
kubectl label node worker-01 node.kubernetes.io/role=worker
kubectl label node worker-01 topology.kubernetes.io/zone=us-east-1a

# Schedule API pods to specific nodes
kubectl patch deployment platform-api -n platform -p '{
  "spec": {
    "template": {
      "spec": {
        "nodeSelector": {
          "node.kubernetes.io/role": "worker"
        }
      }
    }
  }
}'
```

---

## Monitoring Resource Usage via Grafana

### Access Grafana

- **URL:** `https://grafana.$DOMAIN` (in-cluster) or port-forward:
  ```bash
  kubectl port-forward -n monitoring svc/kube-prometheus-grafana 3000:80 &
  ```
- **Username:** `admin`
- **Password:** stored in `/etc/platform/.env` as `GRAFANA_PASSWORD`

### Pre-Installed Dashboards

The kube-prometheus-stack ships with these dashboards:

| Dashboard | Description |
|---|---|
| **Kubernetes / Compute Resources / Namespace (Pods)** | CPU/Memory per pod per namespace |
| **Kubernetes / Compute Resources / Node** | Node-level CPU, memory, disk, network |
| **Kubernetes / Networking** | Network I/O per pod |
| **Node Exporter / Full** | Detailed node metrics |
| **Prometheus / Overview** | Prometheus performance |

### Custom Dashboard for Platform

```json
// Import via Grafana UI: Create → Import → Paste JSON
// Key panels to add:

// Panel 1: API CPU usage (rate(container_cpu_usage_seconds_total{namespace="platform", container="api"}[5m]))
// Panel 2: API Memory (container_memory_usage_bytes{namespace="platform", container="api"})
// Panel 3: Request rate (rate(nginx_ingress_controller_requests{namespace="ingress-nginx"}[5m]))
// Panel 4: PostgreSQL active connections (pg_stat_activity_count)
```

### Add PromQL Queries for Resource Monitoring

```promql
# CPU usage by pod (percentage of request)
rate(container_cpu_usage_seconds_total{namespace="platform"}[5m]) /
on(namespace,pod) kube_pod_container_resource_requests{resource="cpu", namespace="platform"}
* 100

# Memory usage by pod (percentage of request)
container_memory_usage_bytes{namespace="platform"} /
on(namespace,pod) kube_pod_container_resource_requests{resource="memory", namespace="platform"}
* 100

# Disk usage per persistent volume
kubelet_volume_stats_used_bytes{namespace="platform"}
/
kubelet_volume_stats_capacity_bytes{namespace="platform"}
* 100

# Request latency (p95)
histogram_quantile(0.95,
  rate(nginx_ingress_controller_request_duration_seconds_bucket{namespace="ingress-nginx"}[5m])
)
```

### Set Up Alerts

```yaml
# platform-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: platform-alerts
  namespace: monitoring
spec:
  groups:
  - name: platform
    rules:
    - alert: HighCPUUsage
      expr: |
        rate(container_cpu_usage_seconds_total{namespace="platform"}[5m]) /
        on(namespace,pod) kube_pod_container_resource_requests{resource="cpu", namespace="platform"}
        * 100 > 80
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Pod {{ $labels.pod }} CPU usage > 80%"

    - alert: HighMemoryUsage
      expr: |
        container_memory_usage_bytes{namespace="platform"} /
        on(namespace,pod) kube_pod_container_resource_requests{resource="memory", namespace="platform"}
        * 100 > 85
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Pod {{ $labels.pod }} memory usage > 85%"

    - alert: PodNotRunning
      expr: |
        kube_deployment_status_replicas_available{namespace="platform"} <
        kube_deployment_spec_replicas{namespace="platform"}
      for: 2m
      labels:
        severity: critical
```

```bash
kubectl apply -f platform-alerts.yaml
```

---

## Vertical Scaling Guidelines

| Component | Scale Trigger | Action |
|---|---|---|
| Platform API | CPU > 70% for 5m | Increase `limits.cpu` to 2000m, then 4000m |
| Platform API | Memory > 80% for 5m | Increase `limits.memory` to 2Gi, then 4Gi |
| PostgreSQL | Disk > 70% | Increase `primary.persistence.size` and PVC |
| MongoDB | Disk > 70% | Increase `persistence.size` and PVC |
| Prometheus | Retention needs > 30d | Increase `prometheus.prometheusSpec.retention` and disk |
| Loki | Disk > 70% | Increase `loki.persistence.size` |

### Resizing Persistent Volumes

```bash
# 1. Find the PVC
kubectl get pvc -n databases data-postgresql-0

# 2. Edit the PVC to request more storage
kubectl patch pvc data-postgresql-0 -n databases -p '{
  "spec": {
    "resources": {
      "requests": {
        "storage": "50Gi"
      }
    }
  }
}'

# 3. If using a CSI driver, the volume will expand automatically
# 4. If not, you may need to delete/recreate the StatefulSet
# 5. Verify the new size
kubectl get pvc data-postgresql-0 -n databases
```

> **Note:** Not all storage provisioners support online resizing. Check `kubectl get storageclass` for `allowVolumeExpansion: true`.

---

## Resource Sizing Recommendations

| Environment | API Replicas | API CPU/Memory | Portal Replicas | PostgreSQL Disk | MongoDB Disk |
|---|---|---|---|---|---|
| **Development** | 1 | 250m / 256Mi | 1 | 10Gi | 10Gi |
| **Staging** | 2 | 500m / 512Mi | 1 | 20Gi | 20Gi |
| **Production (small)** | 2–3 | 1 / 1Gi | 2 | 50Gi | 50Gi |
| **Production (medium)** | 3–5 | 2 / 2Gi | 2 | 100Gi | 100Gi |
| **Production (large)** | 5–10 | 4 / 4Gi | 3 | 500Gi | 500Gi |

### Total Resource Estimation

| Environment | vCPUs | RAM | Disk |
|---|---|---|---|
| **Development** | 4 | 8Gi | 80Gi |
| **Staging** | 8 | 16Gi | 160Gi |
| **Production (small)** | 16 | 32Gi | 300Gi |
| **Production (medium)** | 32 | 64Gi | 600Gi |
| **Production (large)** | 64 | 128Gi | 2Ti |

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Pod `OOMKilled` | Memory limit too low | `kubectl describe pod -n platform <pod>`; increase `limits.memory` |
| Pod `CrashLoopBackOff` | Out of memory or startup timeout | Check logs: `kubectl logs -n platform <pod> --previous` |
| HPA not scaling | Metrics not available | `kubectl get --raw /apis/metrics.k8s.io/v1beta1` |
| Node `NotReady` | Node out of memory or disk | `kubectl describe node <node>`; free disk space |
| PV `Pending` | No storage class or out of capacity | `kubectl get storageclass`; `kubectl describe pvc` |
| k3s agent won't join | Token mismatch or firewall | Verify `NODE_TOKEN` and port `6443` is open |
| HPA shows `<unknown>` targets | Metrics server not installed | `kubectl top nodes`; install metrics-server |
| Disk pressure on node | Logs or images filling disk | `docker system prune -a`; `k3s ctr images prune` |
