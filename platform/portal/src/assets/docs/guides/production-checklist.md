# Production Launch Checklist

Run through these checks before cutting over to production traffic. Items marked with **"auto"** are verified by `test-deployment.sh`.

---

## 1. TLS Certificates

**Status:** Verify certificate is issued and not expiring soon.

```bash
kubectl get certificate -n platform -o wide
kubectl describe certificate platform-tls -n platform
kubectl get certificaterequest -n platform
```

| Check | Command | Expected |
|---|---|---|
| Certificate Ready | `kubectl get certificate -n platform` | `READY=True` |
| Expiry | `kubectl get certificate -n platform -o jsonpath='{.status.notAfter}'` | > 30 days |
| Auto-renewal | Check cert-manager logs | `cert-manager/controller` logs show renewal check |
| Staging vs Prod | Verify ClusterIssuer | `letsencrypt-prod`, not `letsencrypt-staging` |

---

## 2. Database Backups

**Status:** Verify backup infrastructure and perform a test restore.

```bash
# Check MinIO connectivity
curl -I http://minio.storage:9000

# Verify backup provider is registered
curl -H "Authorization: Bearer $TOKEN" https://$DOMAIN/api/settings/storage

# Trigger a test backup
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"dbName":"platform","environment":"production"}' \
  https://$DOMAIN/api/projects/{projectId}/databases/backup
```

| Check | Details |
|---|---|
| Storage provider configured | Default MinIO or external S3 |
| Backup retention policy | Defined in backup schedule |
| Test restore performed | Restore from backup to isolated DB |
| Backup monitoring | Alert on backup failure |

---

## 3. MinIO / S3 Storage

**Status:** Object storage is accessible and has sufficient free space.

```bash
kubectl get pods -n storage
kubectl get pvc -n storage
```

| Check | Expected |
|---|---|
| MinIO pod Running | `kubectl get pods -n storage` → `Running` |
| PVC bound | `kubectl get pvc -n storage` → `Bound` |
| Free space | `kubectl exec -n storage pod/minio-xxx -- df -h /data` |
| External S3 fallback | If MinIO fails, external S3 configured |
| Default buckets exist | `platform-backups`, `platform-logs` |

---

## 4. SMTP Configuration

**Status:** Email delivery is configured and tested.

```bash
# Test SMTP configuration via API
curl -X POST -H "Authorization: Bearer $TOKEN" \
  https://$DOMAIN/api/settings/smtp/{id}/test \
  -H "Content-Type: application/json" \
  -d '{"testTo":"admin@company.com"}'
```

| Check | Details |
|---|---|
| SMTP provider configured | Custom SMTP, SES, SendGrid, or Mailgun |
| Test email sent | Verify inbox receives notification |
| From address verified | SPF/DKIM records configured for domain |
| SMTP credentials valid | Not expired or revoked |
| Fallback provider | (optional) Secondary SMTP |

---

## 5. Monitoring Dashboards

**Status:** All dashboards load and display data.

```bash
# Verify Grafana is accessible
curl -sI https://$DOMAIN/grafana/

# Check Prometheus targets
curl -s https://$DOMAIN/api/health
```

| Check | Details |
|---|---|
| Grafana accessible | HTTPS 200/302 |
| Prometheus targets healthy | `kubectl get pods -n monitoring` |
| Loki receiving logs | Grafana Explore → Loki → run Log query |
| Pre-built dashboards loaded | Platform Overview, API Performance, Service Health |
| OIDC SSO works | Log in via Platform credentials |

---

## 6. RBAC & Roles

**Status:** Role presets and custom roles are configured, users assigned.

```bash
# Check existing roles
curl -H "Authorization: Bearer $TOKEN" https://$DOMAIN/api/roles

# Verify user permissions
curl -H "Authorization: Bearer $TOKEN" https://$DOMAIN/api/users/{id}/permissions
```

| Check | Details |
|---|---|
| Admin user exists | `admin@company.com` or equivalent |
| DevOps users configured | At least 2 for redundancy |
| Custom roles defined | If needed per team structure |
| Viewer accounts for stakeholders | Read-only access |
| No orphaned `roleId` references | Custom roles that were deleted |

---

## 7. Audit Logging

**Status:** All sensitive operations are logged.

```bash
# View recent audit logs
curl -H "Authorization: Bearer $TOKEN" https://$DOMAIN/api/audit-logs
```

| Check | Details |
|---|---|
| Audit logs accessible | 200 response |
| Secret operations logged | `secrets.create`, `secrets.reveal`, `secrets.delete` |
| User management logged | `user.created`, `user.deleted`, `user.role-updated` |
| Deployment operations logged | `deployment.created`, `deployment.rolled_back` |
| Log retention policy | Defined (default: indefinite in PostgreSQL) |

---

## 8. Resource Limits

**Status:** All deployments have resource requests/limits configured.

```bash
# Check resource limits across namespaces
kubectl get pods -A -o json | jq '.items[] | {name: .metadata.name, ns: .metadata.namespace, limits: .spec.containers[0].resources.limits, requests: .spec.containers[0].resources.requests}'
```

| Check | Details |
|---|---|
| API has resource limits | CPU/Memory requests and limits |
| Portal has resource limits | CPU/Memory requests and limits |
| PostgreSQL has limits | Especially memory limit |
| MongoDB has limits | Especially memory limit |
| Preview namespaces limited | ResourceQuota enforced for preview namespace |

### Recommended Minimum Limits

| Service | CPU Request | CPU Limit | Memory Request | Memory Limit |
|---|---|---|---|---|
| Platform API | 100m | 500m | 256Mi | 512Mi |
| Platform Portal | 50m | 200m | 128Mi | 256Mi |
| PostgreSQL | 500m | 2000m | 1Gi | 4Gi |
| MongoDB | 500m | 2000m | 1Gi | 4Gi |
| Redis | 100m | 500m | 256Mi | 512Mi |
| MinIO | 200m | 1000m | 512Mi | 2Gi |
| Preview (per env) | 50m | 200m | 128Mi | 256Mi |

---

## 9. DNS Records

**Status:** All DNS records are configured and resolving.

```bash
# Verify DNS resolution
nslookup $DOMAIN
dig $DOMAIN +short

# Check all subdomains
for sub in "" "api" "grafana" "argocd" "portainer" "minio"; do
  echo "$sub.$DOMAIN → $(dig +short $sub.$DOMAIN)"
done
```

| Record | Type | Value |
|---|---|---|
| `{DOMAIN}` | A | Server public IP |
| `*.{DOMAIN}` | A | Server public IP (wildcard) |

### Additional Checks

| Check | Details |
|---|---|
| Wildcard DNS configured | Required for preview URLs (`*.preview.{DOMAIN}`) |
| Reverse DNS set | PTR record if required |
| TTL reasonable | 300–600 seconds (before launch), higher after |
| HTTPS reachable | `curl -sI https://$DOMAIN` returns 200 |
| No mixed content | All resources served over HTTPS |
