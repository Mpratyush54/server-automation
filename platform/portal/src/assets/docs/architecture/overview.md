# Architecture Overview

## Control Plane ↔ Execution Plane

```
                              CONTROL PLANE
                          ┌─────────────────────┐
                          │     Browser/Client   │
                          └──────────┬──────────┘
                                     │
                          ┌──────────▼──────────┐
                          │   Nginx Ingress     │
                          │  (SSL termination)  │
                          └──────────┬──────────┘
                                     │
               ┌─────────────────────┼─────────────────────┐
               │                     │                     │
      ┌────────▼──────┐    ┌────────▼───────┐    ┌───────▼──────┐
      │  Portal       │    │  Platform API  │    │   ArgoCD     │
      │  (Angular 19) │    │  (Express/TS)  │    │  (GitOps)    │
      │  :80          │    │  :3000         │    │  :443        │
      └───────────────┘    └────────┬───────┘    └──────────────┘
                                    │
                                    │         EXECUTION PLANE
                    ┌───────────────┼──────────────────┐
                    │               │                  │
           ┌────────▼─────┐ ┌──────▼──────┐  ┌───────▼───────┐
           │  PostgreSQL  │ │   MongoDB   │  │    Redis      │
           │  (entities)  │ │ (logs/      │  │ (cache/pubsub)│
           │              │ │  metrics)   │  │               │
           └──────────────┘ └─────────────┘  └───────────────┘

                    ┌──────────────────────────────────────────────┐
                    │              MinIO / S3                      │
                    │      (file storage, backups)                 │
                    └──────────────────────────────────────────────┘

                    ┌──────────────────────────────────────────────┐
                    │     SDK-Managed Services (user apps)         │
                    │  ┌────────┐ ┌────────┐ ┌─────────┐          │
                    │  │ Node   │ │Python  │ │ React/  │          │
                    │  │ SDK    │ │ SDK    │ │ Angular │          │
                    │  └────────┘ └────────┘ └─────────┘          │
                    └──────────────────────────────────────────────┘
```

## Component Overview

| Component | Technology | Role | Data Store |
|-----------|-----------|------|-----------|
| **API** | Express 4, TypeScript, TypeORM, Mongoose | REST backend — auth, CRUD, secrets, deployments, SDK endpoints | PostgreSQL (entities), MongoDB (logs/metrics) |
| **Portal** | Angular 19, Tailwind, standalone components | Web UI — dashboards, project management, secret editor, OAuth consent | None (thin client) |
| **PostgreSQL** | 16-alpine | Primary data store — users, projects, secrets, roles, deployments, audit logs | Persistent volume |
| **MongoDB** | 7.x | Time-series & unstructured data — logs, API metrics, bug reports, SDK events | Persistent volume |
| **Redis** | 7-alpine | In-memory cache, pub/sub, permission cache, session store | Ephemeral (AOF optional) |
| **MinIO** | Latest | S3-compatible object storage — file uploads, DB backups, bug report screenshots | Persistent volume |

### API Server Structure (`src/server.ts`)

```
src/
├── server.ts                 # Bootstrap: init DB, seed, mount routes, listen
├── config/
│   ├── database.ts           # TypeORM DataSource (PostgreSQL)
│   ├── mongoose.ts           # Mongoose connection (MongoDB)
│   ├── connections.ts        # pg Pool + Redis + Mongo connection managers
│   ├── permissions.ts        # Permission enum + ROLE_PRESETS (5 built-in roles)
│   ├── kubernetes.ts         # K8s API client wrappers (stub fallback)
│   └── index.ts              # initDatabase(), getHealthStatus(), shutdownPlatform()
├── entities/                 # TypeORM entities (18 entities)
│   ├── User.ts, Role.ts      # Auth & RBAC
│   ├── Project.ts, Environment.ts, Deployment.ts
│   ├── Secret.ts, SecretVersion.ts
│   ├── ServiceRegistration.ts, SdkCredential.ts
│   ├── AuditLog.ts, ClickupTaskLink.ts
│   ├── DbConnection.ts, DbBackup.ts
│   ├── File.ts, StorageProvider.ts
│   ├── Alert.ts, SmtpConfig.ts, ProjectConfig.ts
├── routes/                   # 18 route modules
│   ├── auth.ts               # Login, OIDC (/oauth/*), user CRUD, roles
│   ├── sdk.ts                # SDK register, heartbeat, logs, metrics, bug reports
│   ├── secrets.ts            # CRUD, reveal, export, import, rollback, version history
│   ├── deployments.ts        # Deploy, rollback, scale, terminate
│   ├── projects.ts           # Project CRUD
│   ├── webhooks.ts           # GitLab/GitHub webhook receiver
│   ├── cicd.ts               # CI/CD pipeline triggers
│   ├── metrics.ts            # Aggregated metrics queries
│   ├── bug-reports.ts        # Bug report retrieval
│   ├── db-provision.ts       # One-click DB provisioning
│   ├── db-connections.ts     # Connection pool management
│   ├── storage.ts            # File upload/download
│   ├── alerts.ts             # Alert configuration
│   ├── config.ts             # Project config CRUD
│   ├── bootstrap.ts          # Platform bootstrap
│   ├── audit-logs.ts         # Audit log queries
│   └── settings.ts           # SMTP/storage settings
├── lib/
│   ├── secrets-encryption.ts # AES-256-GCM encrypt/decrypt
│   ├── gitlab.ts             # GitLab API — trigger pipelines, get user
│   ├── clickup.ts            # ClickUp API — post comments, extract task IDs
│   ├── infisical.ts          # Infisical secret sync
│   ├── k8s.ts                # K8s resource creation (Deployment, Service, Ingress)
│   ├── lokilog.ts            # Loki log forwarder
│   ├── database-service.ts   # Auto-provision PostgreSQL via K8s
│   ├── preview.ts            # Preview environment manager
│   ├── preview-decay.ts      # 72h TTL scheduler for preview envs
│   ├── storage-service.ts    # Local/MinIO/S3/GoogleDrive adapters
│   └── smtp-service.ts       # Email sending
├── middleware/
│   └── auth.ts               # JWT verify, RBAC, permission cache, SDK token auth
└── schemas/                  # Mongoose schemas (MongoDB collections)
    ├── Log.ts, ApiMetric.ts, MetricsRaw.ts
    ├── BugReport.ts, ErrorDoc.ts, SdkEvent.ts
    ├── FeatureFlag.ts, MetricsHourly.ts
```

## Multi-SDK Architecture

Four SDKs automatically register with the API, send heartbeats, capture metrics/logs, and submit bug reports:

```
┌─────────────────────────────────────────────────────────────────────┐
│                        PLATFORM API                                │
│  POST /api/sdk/register    POST /api/sdk/heartbeat                │
│  POST /api/sdk/logs        POST /api/sdk/api-metrics              │
│  POST /api/sdk/bug-report  GET  /api/sdk/config                   │
│  GET  /api/sdk/db-credentials                                     │
└─────────────────────────────────────────────────────────────────────┘
           ▲              ▲              ▲              ▲
           │              │              │              │
   ┌───────┴──────┐ ┌────┴────┐ ┌───────┴───────┐ ┌───┴────────┐
   │  Node.js SDK │ │  Python  │ │   React SDK   │ │ Angular SDK│
   │ @mpratyush54 │ │ platform │ │ @mpratyush54  │ │ @mpratyush54│
   │ /sdk-node    │ │ -sdk-    │ │ /sdk-react    │ │ /sdk-angular│
   │              │ │ python   │ │               │ │            │
   └──────────────┘ └─────────┘ └───────────────┘ └─────────────┘
```

| SDK | Package | Auth | Key Feature |
|-----|---------|------|-------------|
| **Node.js** | `@mpratyush54/sdk-node` | `sdk-{projectId}:{secret}` or `sdk_live_{uuid}` | `PlatformClient.init()` — auto-register, heartbeat, metrics middleware, console capture, Winston/Pino transports, DB managers (pg, mongo, redis) |
| **Python** | `platform-sdk-python` | SDK token | `PlatformClient()` — registration, metrics, logging, config fetch |
| **React** | `@mpratyush54/sdk-react` | SDK token | `<PlatformProvider>` — hook-based API, `<ErrorBoundary>`, `<BugReporterWidget>`, `usePlatform()`, `useBugReporter()` |
| **Angular** | `@mpratyush54/sdk-angular` | SDK token | `PlatformModule` — HTTP interceptor, `ErrorHandler`, `BugReporterComponent` |

## External Integrations

```
┌─────────────────────────────────────────────────────────────────────┐
│                        PLATFORM API                                │
│                                                                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐      │
│  │ GitLab   │  │ GitHub   │  │ ClickUp  │  │  Infisical   │      │
│  │ CI/CD    │  │ Actions  │  │ Tasks    │  │  Secrets     │      │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └──────┬───────┘      │
│       │              │             │               │               │
│  ┌────▼──────────────▼─────────────▼───────────────▼──────────┐  │
│  │  Webhooks → cicd.ts   postComment()    fetchSecrets()      │  │
│  │  triggerPipeline()                    decryptValue()       │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

### GitLab/GitHub CI/CD (`src/lib/gitlab.ts`, `src/routes/webhooks.ts`)
- **Webhook receiver**: `POST /api/webhooks/gitlab` / `POST /api/webhooks/github`
- Validates X-Gitlab-Token / X-Hub-Signature, extracts branch, commit SHA, project
- Creates/updates preview environments per branch, deploys to k3s
- Posts ClickUp comments with preview URLs
- **Pipeline trigger**: `triggerPipeline(projectId, branch)` — fires GitLab pipeline via API token

### ClickUp (`src/lib/clickup.ts`)
- **Bug report → task**: When SDK submits a bug report, if the project has `clickupListId`, a task is created
- **Preview env notification**: `formatPreviewComment()` generates formatted comment with branch, URL, expiry
- **Task extraction**: `extractTaskId(branch)` — parses `CU-12345` from branch name

### Infisical (`src/lib/infisical.ts`)
- **Fallback secret sync**: `fetchSecrets(projectId, environment)` — reads from Platform's own Secret entity (AES-256-GCM), returns plaintext map
- Used by SDK config endpoint (`GET /api/sdk/config`) and DB credentials endpoint (`GET /api/sdk/db-credentials`)

## Key Design Decisions

### 1. Password-less Authentication (Email-only Login)
- `POST /api/auth/login` accepts **only email** — no password
- If email exists in the `users` table, a JWT is issued immediately
- Rationale: Simplifies auth for internal PaaS; relies on network-level security (ingress TLS, mTLS for production)
- Demo seeding creates 4 users (admin, devops, tech_lead, developer) on first boot

### 2. JWT-based Sessions
- Tokens signed with `JWT_SECRET` env var (default: `plat-super-secret-key`)
- Expiry: **24 hours** for login JWT, **1 hour** for OIDC access tokens
- Payload: `{ id, email, name, role }` — no password hash needed
- `expressAuthenticate` middleware verifies JWT on every protected route, attaches `req.user`

### 3. RBAC with Cached Permissions
- `ROLE_PRESETS` defined in `src/config/permissions.ts` — 5 roles (admin, devops, tech_lead, developer, viewer)
- **In-memory cache**: `Map<userId, { permissions: Set<string>, expiresAt: number }>` — 60s TTL
- `clearPermissionCache(userId?)` called on role change, role update, or user delete
- `requirePermission(...permissions)` async middleware resolves user permissions and checks all required perms

### 4. Dual-Database Strategy
- **PostgreSQL** (TypeORM): Relational entities — users, projects, secrets, deployments, roles, audit logs. Synchronized via `synchronize: true`
- **MongoDB** (Mongoose): Schema-less, time-series data — logs, API metrics, raw metrics, bug reports, SDK events, error docs. Non-blocking connect
- Rationale: PostgreSQL for ACID compliance on business data; MongoDB for high-volume write throughput on observability data

### 5. In-Memory Permission Cache over Redis
- Permissions cached in a process-local `Map` rather than Redis to avoid latency
- Cache cleared on role mutation; stale cache tolerated for max 60s
- Suitable for single-replica API deployment (horizontal scaling would need distributed cache)

### 6. SDK-First Auto-Provisioning
- SDK `init()` triggers auto-registration which creates K8s Deployment, Service, Ingress, and ArgoCD Application
- Databases auto-provisioned (PostgreSQL via `provisionPostgresDb`)
- Preview environments created per branch with 72h TTL decay scheduler
