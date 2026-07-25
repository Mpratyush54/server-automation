# Data Flow — Request Lifecycle

## Complete Request Sequence

```mermaid
sequenceDiagram
    participant Browser as Browser / Client
    participant Nginx as Nginx Ingress
    participant Portal as Portal (Angular)
    participant API as Platform API
    participant PG as PostgreSQL
    participant Mongo as MongoDB
    participant Redis as Redis

    Browser->>Nginx: 1. HTTPS request<br/>(SSL via cert-manager LE)
    Nginx->>Portal: 2a. / or /index.html
    Portal-->>Nginx: (static assets)
    Nginx->>API: 2b. /api/*
    API->>PG: 3. Query entities (TypeORM)
    PG-->>API: rows
    API->>Mongo: 4. Write logs/metrics
    Mongo-->>API: ack
    API->>Redis: 5. Cache check / publish
    Redis-->>API: value
    API-->>Nginx: 6. JSON response
    Nginx-->>Browser: JSON
    Portal-->>Browser: 7. Render Angular SPA
```

## Detailed Flow: Browser → Portal → API

### Step 1: SSL Termination (Nginx Ingress)

```yaml
# Ingress controller: kubernetes/ingress-nginx (host network mode)
# SSL certs managed by cert-manager + Let's Encrypt (letsencrypt-prod ClusterIssuer)

Annotations applied to Ingress resources:
  kubernetes.io/ingress.class: nginx
  cert-manager.io/cluster-issuer: letsencrypt-prod  # only for real domains
```

- Wildcard TLS cert: `*.sslip.io` via `spec.tls[0].hosts`
- Internal (sslip.io): bypasses cert-manager, uses self-signed
- Real domains: cert-manager provisions Let's Encrypt certs automatically

### Step 2: Subpath Routing

| Path | Destination | Service | Port |
|------|------------|---------|------|
| `/` | Portal (Angular SPA) | `portal-service` | 80 |
| `/api` | Platform API | `api-service` | 3000 |
| `/grafana` | Grafana dashboards | `grafana-service` | 3001 |
| `/argocd` | ArgoCD UI | `argocd-server` | 443 |
| `/portainer` | Portainer | `portainer-service` | 9000 |

### Step 3: API → PostgreSQL (TypeORM Entities)

```mermaid
graph LR
    A["API Route<br/>Handler"] --> B["TypeORM Repo<br/>getDb"]
    subgraph C[PostgreSQL 16]
        E1[users]
        E2[projects]
        E3[secrets]
        E4[secret_versions]
        E5[roles]
        E6[audit_logs]
        E7[deployments]
        E8[service_registrations]
        E9[db_connections]
        E10[...more]
    end
    B --> E1
    B --> E2
    B --> E3
    B --> E7
```

- Singleton `DataSource` initialized in `config/database.ts` with `synchronize: true`
- Entity relations: `User → Role`, `Project → Environment → Deployment`, `Secret → SecretVersion`
- Connection: `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`

Example from `server.ts`:
```typescript
const ds = await getDb();
const userRepo = ds.getRepository(User);
const user = await userRepo.findOne({ where: { email } });
```

### Step 4: API → MongoDB (Logs/Metrics/Events)

```mermaid
graph LR
    subgraph SDK[SDK Routes]
        R1["POST /sdk/logs"]
        R2["POST /sdk/api-metrics"]
        R3["POST /sdk/bug-report"]
        R4["POST /sdk/heartbeat"]
    end
    M["Mongoose<br/>connectMongo"]
    subgraph DB[MongoDB 7 collections]
        C1[logs]
        C2[apimetrics]
        C3[metricsraw]
        C4[bugreports]
        C5[errordocs]
        C6[sdkevents]
        C7[featureflags]
    end
    R1 --> M
    R2 --> M
    R3 --> M
    R4 --> M
    M --> C1
    M --> C2
    M --> C3
    M --> C4
    M --> C5
    M --> C6
    M --> C7
```

- Non-blocking: MongoDB connect failure does not crash API (warning logged)
- Mongoose schemas in `src/schemas/` — `Log.ts`, `ApiMetric.ts`, `BugReport.ts`, `MetricsRaw.ts`, etc.

Log ingestion (`POST /api/sdk/logs`):
```typescript
await LogModel.insertMany(resolvedLogs);       // MongoDB
await forwardToLoki(resolvedLogs);             // Loki (parallel)
```
Error tracking (upsert by projectId + errorType + stackHash):
```typescript
await ErrorDocModel.findOneAndUpdate(query, { $inc: { occurrenceCount: 1 } }, { upsert: true });
```

### Step 5: API → Redis (Caching/Pub-Sub)

```mermaid
graph LR
    subgraph Active[Currently Active]
        PC[Permission Cache<br/>in-memory Map<br/>userId to Set<br/>60s TTL]
    end
    subgraph RedisBox[Redis 7]
        NC[Not currently used<br/>for caching<br/>see design notes]
        FU[Available for future:<br/>- Session store<br/>- Pub/sub<br/>- Rate limit]
    end
```

The `config/connections.ts` provides `RedisConnection` class with `get/set/healthCheck` methods, but the API primarily uses an **in-memory permission cache** (`Map<userId, { permissions: Set<string>, expiresAt: number }>`) rather than Redis, to avoid network latency on every request.

### Step 6: SDK → API Telemetry Flow

```mermaid
graph TB
    subgraph SDK[SDK-ENABLED SERVICE]
        Init[PlatformClient.init options]
        Init --> Reg[POST /api/sdk/register]
        Init --> HB[POST /api/sdk/heartbeat<br/>every 15s]
        Init --> Logs[POST /api/sdk/logs<br/>every 5s / 50 entries]
        Init --> APIM[POST /api/sdk/api-metrics<br/>every 5s / 100 entries]
        Init --> Bug[POST /api/sdk/bug-report]
        Init --> Cfg[GET /api/sdk/config]
    end
    Reg --> RegT[ServiceRegistration PG]
    HB --> HBT1[MetricsRaw Mongo]
    HB --> HBT2[ServiceRegistration.lastSeen]
    Logs --> LT1[LogModel Mongo + Loki]
    Logs --> LT2[ErrorDoc Mongo upsert]
    APIM --> APIMT[ApiMetricModel Mongo]
    Bug --> BT1[BugReportModel Mongo]
    Bug --> BT2[ClickUp task<br/>if configured]
    Cfg --> CT[ProjectConfig + Secret PG]
```

SDK token authentication (`src/middleware/auth.ts`):
```typescript
// Two token formats supported:
// 1. "sdk-{projectId}:{secret}"  — lightweight, inline project ID
// 2. "sdk_live_{uuid}"           — full SdkCredential lookup in PostgreSQL
```

### Step 7: API → ArgoCD (GitOps Sync)

```mermaid
graph LR
    A[SDK Register<br/>service starts] --> B[SDK Route<br/>src/routes/<br/>sdk.ts:140-175]
    B --> C[ArgoCD<br/>CustomObjectsApi]
    B --> D[Creates ArgoCD Application<br/>if project.repositoryUrl is set]
    D --> E[apiVersion: argoproj.io/v1alpha1<br/>kind: Application<br/>name: project-staging<br/>repoURL: repositoryUrl<br/>targetRevision: main<br/>path: k8s<br/>syncPolicy: automated<br/>prune + selfHeal]
```

### Step 8: API → MinIO/S3 (File Storage)

```mermaid
graph TB
    A[Storage Routes<br/>/api/files<br/>/api/storage] --> B[Adapter<br/>createAdapter<br/>providerType]
    B --> L[Local FS]
    B --> M[MinIO/S3<br/>S3Compat]
    B --> G[Google Drive]
```

Adapter selection (`src/lib/storage-service.ts`):
```typescript
function createAdapter(providerType, credentials, bucketName?, endpointUrl?): StorageAdapter
  - 'google_drive' → GoogleDriveAdapter (OAuth2 refresh token)
  - 's3'           → S3Adapter (AWS SDK v3)
  - 'minio'        → S3Adapter (endpoint forced to minio:9000)
  - default        → LocalAdapter (./storage directory)
```

## Asynchronous Processing

| Operation | Trigger | Execution | Error Handling |
|-----------|---------|-----------|---------------|
| Bug report → ClickUp | `POST /api/sdk/bug-report` | Fire-and-forget `(async () => { ... })()` | Silent catch |
| Log enrichment (ErrorDoc) | `POST /api/sdk/logs` | Inline after LogModel.insertMany | Silent catch |
| ArgoCD Application create | `POST /api/sdk/register` | Inline with retry (create → replace) | Silent catch |
| K8s resources create | `POST /api/sdk/register` | Inline (create → replace fallback) | Silent catch |
| DB auto-provision | `POST /api/sdk/register` | Inline via `provisionPostgresDb()` | Silent catch |
| Preview env decay | Scheduler (startup) | `setInterval` checking 72h threshold | Logged |

## Error Response Format

All API errors follow a consistent envelope:
```json
{
  "error": "User email not found. Run init-demo first.",
  "required": ["secrets.reveal"]  // only for 403 permission failures
}
```

HTTP Status Codes:
| Code | Meaning | Source |
|------|---------|--------|
| 200 | Success | All routes |
| 201 | Created | POST routes |
| 400 | Bad request | Validation failures |
| 401 | Unauthorized | Missing/invalid JWT or SDK token |
| 403 | Forbidden | Insufficient RBAC permissions |
| 404 | Not found | Entity not found |
| 409 | Conflict | Duplicate email/role name |
| 500 | Server error | Encryption key missing, internal failure |
