# CAPS Platform — Detailed Product & Execution Plan
**Version:** 2.0 | **Owner:** CAPS Engineering | **Classification:** Internal

---

## Table of Contents

1. [Overview & Vision](#1-overview--vision)
2. [Team & Roles](#2-team--roles)
3. [System Architecture](#3-system-architecture)
4. [Portal — Role-Based Views](#4-portal--role-based-views)
5. [Preview Environment Pipeline](#5-preview-environment-pipeline)
6. [ClickUp Integration](#6-clickup-integration)
7. [SDK — @caps/sdk-node & caps-sdk-python](#7-sdk--capssdk-node--caps-sdk-python)
8. [Module Specifications](#8-module-specifications)
9. [Database Schema](#9-database-schema)
10. [API Reference](#10-api-reference)
11. [Bootstrap Engine](#11-bootstrap-engine)
12. [Repository Structure](#12-repository-structure)
13. [Execution Roadmap](#13-execution-roadmap)
14. [Critical Design Principles](#14-critical-design-principles)
15. [Open Questions & Decisions Log](#15-open-questions--decisions-log)

---

## 1. Overview & Vision

CAPS Platform is a self-hosted internal Platform-as-a-Service (PaaS) purpose-built for CAPS Engineering. It manages the full lifecycle of every CAPS service — from the moment a developer pushes code to the moment a feature is live in production — without requiring any developer to touch kubectl, Helm, ArgoCD, Infisical, or any infrastructure tool directly.

### The desired developer workflow

```
git push origin feature/CU-842-auth-fix
```

That single command triggers:

- Docker image build (GitLab CI)
- Kubernetes deployment to a preview environment
- Unique preview URL generation (`cu-842-auth-fix.preview.capskengeri.com`)
- ClickUp task updated with the preview URL as a comment
- SDK auto-registration on first boot
- Metrics, logs, and health status visible in the portal immediately

No manual steps. No kubectl. No Slack messages asking "what's the URL".

### Scale Targets

| Dimension | Current | Target |
|---|---|---|
| Developers | 14 | 30+ |
| Active projects | 10 | 30+ |
| Services | ~15 | 100+ |
| Environments per project | 2 (staging, prod) | 4 (preview, dev, staging, prod) |

---

## 2. Team & Roles

### Portal Access Roles

There are three distinct roles in CAPS Platform. Every UI element, API endpoint, and SDK capability is scoped to one of these roles.

| Role | Who | What they can do |
|---|---|---|
| **Developer** | All Tech Tank members | View their own projects, see staging deployments, read metrics and logs for staging, access preview URLs, manage their own feature configs |
| **Tech Lead** | CAPS Tech Leads | All developer access + read production metrics and logs, approve promotions from staging → production, view all projects across teams |
| **DevOps** | Platform/Infra engineers | Full access — deploy, rollback, manage secrets metadata, bootstrap nodes, manage storage routing, delete projects, view all audit logs |

### Portal View Differences

**Developer view hides:** Production deploy/rollback buttons, production secret metadata, cluster-level metrics, bootstrap controls, audit logs for other users' actions.

**Tech Lead view hides:** Production deploy/rollback buttons (read-only prod), bootstrap controls, raw cluster metrics.

**DevOps view shows:** Everything. Including a dedicated Infrastructure tab with node health, cluster resource utilization, and bootstrap history.

---

## 3. System Architecture

### Three-Plane Model

```
┌─────────────────────────────────────────────────────────────┐
│                      CONTROL PLANE                          │
│  Portal Dashboard (Angular)  +  Platform API (Next.JS)       │
│                                                             │
│  ┌──────────────┐ ┌──────────────┐ ┌───────────────────┐   │
│  │ Project      │ │ Deployment   │ │ CI/CD Engine      │   │
│  │ Engine       │ │ Engine       │ │ (GitLab API)      │   │
│  └──────────────┘ └──────────────┘ └───────────────────┘   │
│  ┌──────────────┐ ┌──────────────┐ ┌───────────────────┐   │
│  │ Config       │ │ Storage      │ │ Bootstrap         │   │
│  │ Engine       │ │ Engine       │ │ Engine            │   │
│  └──────────────┘ └──────────────┘ └───────────────────┘   │
│  ┌──────────────┐ ┌──────────────┐                         │
│  │ Metrics      │ │ Logging      │                         │
│  │ Engine       │ │ Engine       │                         │
│  └──────────────┘ └──────────────┘                         │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                     EXECUTION PLANE                         │
│  Kubernetes (KVM8 master + fresh worker nodes)              │
│  PostgreSQL  │  MongoDB  │  Redis  │  MinIO                 │
│  Prometheus + Grafana  │  Loki                              │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                       SDK LAYER                             │
│  @caps/sdk-node (npm)  │  caps-sdk-python (pip)             │
│  Installed in every CAPS service                            │
│  Auto-registration │ Metrics │ Logs │ Config │ DB │ Storage │
└─────────────────────────────────────────────────────────────┘
```

### Data Flow — Request Lifecycle

```
Service Boot
  → SDK reads GIT_BRANCH, GIT_COMMIT, INFISICAL_PROJECT_ID from env
  → SDK fetches DB credentials from Infisical via Platform API
  → SDK establishes connection pools (PG, Mongo, Redis)
  → SDK sends auto-registration payload to POST /sdk/register
  → Platform stores registration in service_registrations table
  → Portal shows service as "Online" within 15 seconds

Every 15 seconds
  → SDK collects CPU, memory, uptime, request count, error rate, DB health
  → SDK sends heartbeat to POST /sdk/heartbeat
  → Platform writes to metrics_raw (MongoDB, TTL-indexed)
  → Portal graphs update in real time

Every few seconds (async, non-blocking)
  → SDK batches log entries
  → SDK sends to POST /sdk/logs
  → Platform forwards to Loki
  → Logs searchable in portal log viewer immediately
```

---

## 4. Portal — Role-Based Views

### Global Navigation

```
CAPS Platform
├── Overview          (all roles — scoped by role)
├── Projects          (all roles — scoped by role)
│   ├── [Project]
│   │   ├── Deployments
│   │   ├── Metrics
│   │   ├── Logs
│   │   ├── Config
│   │   ├── Storage
│   │   └── Environments
├── Preview URLs      (all roles)
├── ClickUp           (all roles — read, DevOps can configure)
├── Infrastructure    (DevOps only)
│   ├── Nodes
│   ├── Namespaces
│   ├── Bootstrap
│   └── Cluster Metrics
└── Audit Log         (Tech Lead + DevOps)
```

### Overview Page — Per Role

**Developer:** Cards for each of their own projects showing — current deployed branch, uptime, error rate, last deployment time, preview URL if active.

**Tech Lead:** Same cards for all projects across all teams. Red/amber/green health indicators. A "Pending Approvals" section for staging → production promotions awaiting sign-off.

**DevOps:** Full dashboard including cluster CPU/memory, node count and health, storage quota utilization, active preview environments count, recent bootstrap jobs.

### Project Detail Page

Every project detail page has tabs:

**Deployments tab**
- Table: version, branch, commit SHA, deployed by, deployed at, status
- Rollback button (Tech Lead + DevOps only for production)
- Deploy button to trigger new build
- Environment selector: preview / staging / production

**Metrics tab**
- CPU % over time (line chart, last 1h / 6h / 24h selectable)
- Memory usage over time
- Request count per minute
- Average response time (p50, p95, p99)
- Error rate (4xx, 5xx separately)
- DB connection health (pool utilization per DB type)
- All metrics from live Prometheus data via Platform API proxy

**Logs tab**
- Real-time log stream from Loki
- Filter by: log level (INFO, WARN, ERROR), time range, search text
- Each log line tagged with: timestamp, level, service, environment, commit SHA

**Config tab**
- Table of all `caps.config()` keys for this project
- Per-environment value editor (DevOps and Tech Lead)
- Change history: who changed what, when
- Hierarchy display: Global → Project → Environment → Instance

**Storage tab**
- Files uploaded by this project with metadata (provider, bucket, size, upload time)
- Storage routing config: which file type goes to which provider
- Quota usage bar

**Environments tab**
- List of environments: preview instances, staging, production
- For each: status, URL, last deployed, branch, SDK registration status
- Preview environments show TTL countdown and "Delete now" option

---

## 5. Preview Environment Pipeline

### URL Convention (Non-Negotiable)

Branch name is sanitized to lowercase alphanumeric + hyphens. Task ID is preserved.

```
feature/CU-842-auth-fix  →  cu-842-auth-fix.preview.capskengeri.com
feature/CU-123-upload    →  cu-123-upload.preview.capskengeri.com
fix/CU-99-crash          →  cu-99-crash.preview.capskengeri.com
```

All preview URLs live under `*.preview.capskengeri.com`. A single wildcard TLS certificate covers all of them. This is provisioned once as part of cluster setup, never per-branch.

### Branch Naming Convention (Enforced by CI)

GitLab CI rejects pushes that do not follow the pattern `feature/CU-{id}-{description}` or `fix/CU-{id}-{description}`. This is enforced at the pipeline level, not by convention. A failed naming check produces a clear error message with the correct format.

This is the foundation that makes ClickUp linking automatic — no custom fields, no manual task ID entry.

### Kubernetes Structure for Previews

All preview deployments share a single `preview` namespace. Each branch gets:

- One Deployment named `preview-{sanitized-branch}`
- One Service named `preview-{sanitized-branch}`
- One Ingress rule routing `{sanitized-branch}.preview.capskengeri.com` to that Service

This keeps the cluster clean — no namespace sprawl. The `preview` namespace has resource quotas to prevent any single preview from consuming excessive cluster resources.

### Preview Lifecycle

```
Branch pushed
  → GitLab CI builds Docker image tagged with sanitized branch name
  → CI applies Kubernetes manifests to preview namespace
  → Ingress rule created/updated
  → SDK boots in preview pod, auto-registers with environment = "preview"
  → Platform generates preview URL, stores in deployments table
  → ClickUp comment posted with URL

Branch deleted (or PR merged)
  → GitLab CI cleanup job deletes Deployment, Service, Ingress from preview namespace
  → Platform marks deployment as "terminated"
  → ClickUp task gets a follow-up comment: "Preview environment terminated"

TTL fallback (72 hours since last push)
  → CronJob in Kubernetes scans preview namespace
  → Identifies deployments with last_heartbeat older than 72 hours
  → Deletes them automatically
  → Platform marks as "expired"
```

### GitLab CI Template (Conceptual — no code, for planning)

The CI/CD Engine generates a reusable `.gitlab-ci.yml` template for preview environments. Every CAPS project includes this template — they do not write their own preview pipeline. The template handles:

- Image build and push to GitLab registry
- Sanitization of branch name
- Apply Kubernetes manifests with correct naming
- Post-deploy notification to Platform API (which then handles ClickUp)
- Cleanup job on branch delete

Projects extend the template with their own build steps only.

---

## 6. ClickUp Integration

### What CAPS Platform Does in ClickUp

| Trigger | Platform Action | ClickUp Result |
|---|---|---|
| Preview URL generated | POST to ClickUp API | Comment on task with URL, environment, branch, expiry |
| Task moved to "In Review" | ClickUp webhook → Platform → GitLab pipeline trigger | Pipeline fires on linked branch |
| Preview deployment failed | POST to ClickUp API | Comment on task with failure reason |
| Preview expired / terminated | POST to ClickUp API | Comment on task noting environment is gone |
| Staging → Production promoted | POST to ClickUp API | Comment on task with production URL |

### Webhook Receiver

The Platform API exposes `POST /integrations/clickup/webhook`. ClickUp is configured to POST to this endpoint on status changes.

On receiving a status change to "In Review":

1. Platform extracts the task ID from the webhook payload
2. Platform searches `deployments` table for a deployment where `clickup_task_id` matches
3. If found: checks if a pipeline is already running — if yes, skips. If no, triggers GitLab pipeline via GitLab API
4. If not found: Platform attempts to extract task ID from recent branch pushes (branch name contains `CU-{id}`) and links them
5. Platform stores the association in `clickup_task_links` table for future events

### Task ID → Branch Linking Logic

```
ClickUp Task ID: CU-842
  → Platform queries: SELECT * FROM deployments WHERE branch LIKE '%CU-842%'
  → Found: feature/CU-842-auth-fix on project: caps-automation
  → GitLab pipeline triggered on that branch
  → Association stored: clickup_task_id = CU-842, deployment_id = xyz
```

If no branch is found (developer hasn't pushed yet), the webhook is stored in a pending queue. When a matching branch is pushed later, the pending webhook is processed and the pipeline fires.

### ClickUp Comment Format

When a preview URL is ready, the comment posted to the task looks like this:

```
✅ Preview environment ready

Project:     caps-automation
Branch:      feature/CU-842-auth-fix
URL:         https://cu-842-auth-fix.preview.capskengeri.com
Deployed at: 14:32 IST, 24 June 2026
Expires:     72 hours after last push
Commit:      a3f92c1

Triggered by: git push
```

### ClickUp Configuration Required (One-Time Setup)

A DevOps engineer configures the following in ClickUp once:

- Outgoing webhook pointing to `https://platform.capskengeri.com/integrations/clickup/webhook`
- Webhook triggers on: status changed to "In Review"
- A ClickUp API token stored in Infisical under the platform's own secret path
- The Platform reads this token from Infisical at startup — it is never hardcoded

---

## 7. SDK — @caps/sdk-node & caps-sdk-python

### Installation

```bash
# Node.js
npm install @caps/sdk-node

# Python
pip install caps-sdk-python
```

Both packages are published to CAPS GitLab's private package registry. They are not on npm or PyPI public registries.

### Initialization

**Node.js:**
```javascript
import caps from '@caps/sdk-node';

caps.init({
  projectName: 'caps-automation-backend',
  platformUrl: 'https://platform.capskengeri.com',
  databases: ['postgres', 'redis', 'mongo'],
});
```

**Python:**
```python
from caps_sdk import caps

caps.init(
    project_name='caps-automation-backend',
    platform_url='https://platform.capskengeri.com',
    databases=['postgres', 'redis'],
)
```

`caps.init()` is the only required call. Everything else is automatic.

### What Happens on init()

```
1. Read environment variables:
   - CAPS_PROJECT_NAME (fallback to projectName param)
   - GIT_BRANCH (injected by GitLab CI)
   - GIT_COMMIT (injected by GitLab CI)
   - INFISICAL_PROJECT_ID
   - INFISICAL_ENVIRONMENT
   - NODE_ENV / PYTHON_ENV

2. Fetch DB credentials from Platform API (/sdk/db-credentials)
   - Platform proxies to Infisical
   - Credentials cached locally in memory

3. Establish connection pools for each database in `databases` array

4. Send auto-registration payload to /sdk/register

5. Start heartbeat timer (every 15 seconds)

6. Start log batch timer (every 3 seconds)

7. Fetch initial config values from /sdk/config and cache them

8. SDK ready — caps.db.*, caps.config(), caps.storage.* all available
```

### Database Access

The SDK is the only database client in any CAPS service. Services must not instantiate pg, mongoose, ioredis, or any database driver directly.

**Node.js:**
```javascript
// PostgreSQL
const users = await caps.db.postgres.query('SELECT * FROM users WHERE id = $1', [userId]);

// Redis
await caps.db.redis.set('session:123', JSON.stringify(sessionData), 'EX', 3600);
const session = await caps.db.redis.get('session:123');

// MongoDB
const db = caps.db.mongo.db('caps_automation');
const certs = db.collection('certificates');
await certs.insertOne({ userId, issuedAt: new Date() });
```

**Python:**
```python
# PostgreSQL
rows = caps.db.postgres.execute('SELECT * FROM users WHERE id = %s', [user_id])

# Redis
caps.db.redis.set('session:123', json.dumps(session_data), ex=3600)

# MongoDB
col = caps.db.mongo['caps_automation']['certificates']
col.insert_one({'user_id': user_id, 'issued_at': datetime.now()})
```

### Config Access

```javascript
// Fetch a runtime config value
const bucket = caps.config('storage.bucket');
const maxFileSize = caps.config('uploads.max_size_mb');
const featureEnabled = caps.config('feature.new_dashboard');

// With default fallback
const timeout = caps.config('api.timeout_ms', 5000);
```

Config values are set per-project per-environment in the CAPS Portal. Changing a value in the portal takes effect within 30 seconds in all running instances — no redeployment required.

Config hierarchy (lower overrides higher):

```
Global default
  → Project default
    → Environment override (staging / production)
      → Instance override (specific pod, for debugging)
```

### Storage Access

```javascript
// Upload a file
const result = await caps.storage.upload(fileBuffer, {
  filename: 'certificate-123.pdf',
  contentType: 'application/pdf',
  category: 'certificates',   // Platform routes this to Google Drive per routing config
});

// Get a signed URL for direct client download
const url = await caps.storage.signedUrl(result.fileId, { expiresIn: 3600 });

// Delete a file
await caps.storage.delete(result.fileId);
```

The `category` field determines which storage provider is used, based on routing config set in the portal:

```json
{
  "certificates": "google-drive",
  "media": "s3",
  "uploads": "minio",
  "temp": "local"
}
```

Changing this routing in the portal re-routes all future uploads with no code change.

### Log Forwarding

The SDK wraps the existing logger transparently.

**Node.js (Winston):**
```javascript
// Replace this:
import winston from 'winston';
const logger = winston.createLogger(...);

// With this:
import { logger } from '@caps/sdk-node';

// Same API, logs now also forwarded to CAPS Platform
logger.info('User logged in', { userId: 123 });
logger.error('DB query failed', { error: err.message });
```

**Python:**
```python
from caps_sdk import logger

logger.info('User logged in', extra={'user_id': 123})
logger.error('DB query failed', extra={'error': str(e)})
```

Every log entry forwarded to the platform is tagged with: project, environment, branch, commit SHA, hostname, log level, timestamp.

### SDK Design Guarantees

| Guarantee | Implementation |
|---|---|
| Non-blocking | All platform calls are fire-and-forget, never awaited in request path |
| Fail silent | try/catch wraps every platform call; errors logged internally only |
| Cached | Config and credentials cached in memory; stale cache used if platform unreachable |
| Async | All operations are async/await; no synchronous blocking calls |
| Platform-downtime safe | Running services continue normally if CAPS Platform is down |
| Graceful shutdown | SIGTERM handler drains connection pools before exit |

---

## 8. Module Specifications

### Module 1 — Project Engine

**Purpose:** Manages the full lifecycle of a project from creation to deletion.

**Supported project types:** Node.js, Angular, Python, Static sites

**Create project flow:**
1. DevOps or Tech Lead fills project creation form in portal
2. Platform creates record in `projects` table
3. Platform creates `environments` records: staging and production by default
4. CI/CD Engine generates `.gitlab-ci.yml`, `Dockerfile`, and Helm chart templates
5. Platform creates Kubernetes namespace for staging: `{project-name}-staging`
6. Platform creates Kubernetes namespace for production: `{project-name}-prod`
7. Platform registers project in Infisical (creates project + environments)
8. Project appears in portal, ready for first deployment

**Delete project flow:**
DevOps only. Requires explicit confirmation. Deletes namespaces, removes from DB, archives logs (does not delete logs immediately — 30-day archive before purge).

---

### Module 2 — Deployment Engine

**Purpose:** Manages all deployment operations across all environments.

**Deploy flow:**
1. GitLab CI builds and pushes Docker image tagged with commit SHA
2. CI calls `POST /deploy` with project ID, environment, image tag, branch, commit SHA
3. Platform updates ArgoCD Application spec with new image tag
4. ArgoCD syncs to cluster
5. Platform polls ArgoCD sync status every 5 seconds
6. On success: `deployments` record updated with status = "deployed"
7. On failure: deployment marked "failed", previous version remains live, alert triggered

**Rollback flow:**
1. Tech Lead or DevOps selects a previous deployment from history
2. Platform calls ArgoCD API to sync to that image tag
3. Same poll loop as deploy
4. Audit log records: who rolled back, from which version, to which version, at what time

**Deployment history:** Last 50 deployments per project per environment stored. Older records archived to cold storage after 90 days.

**Deployment statuses:** pending → building → deploying → deployed / failed / rolled-back / terminated

---

### Module 3 — SDK Engine

**Purpose:** Handles all inbound SDK communication — registration, heartbeats, log ingestion, config serving, credential serving.

**Registration:** Idempotent. If a service re-registers (restart), existing record is updated not duplicated. Keyed on project + environment + hostname.

**Heartbeat processing:**
- Received every 15 seconds per SDK instance
- Written to `metrics_raw` MongoDB collection (TTL: 7 days for raw data)
- Aggregated into hourly summaries in `metrics_hourly` (TTL: 90 days)
- If no heartbeat for 45 seconds: service marked "degraded" in portal
- If no heartbeat for 90 seconds: service marked "offline", alert triggered

---

### Module 4 — Metrics Engine

**Metrics collected per heartbeat:**

| Metric | Source | Unit |
|---|---|---|
| CPU usage | process.cpuUsage() / psutil | Percentage |
| Memory usage | process.memoryUsage() / psutil | MB |
| Heap used (Node only) | process.memoryUsage().heapUsed | MB |
| Uptime | process start time | Seconds |
| Request count | SDK middleware counter | Count since last heartbeat |
| Average response time | SDK middleware timer | Milliseconds |
| p95 response time | SDK middleware timer | Milliseconds |
| Error rate 4xx | SDK middleware counter | Count since last heartbeat |
| Error rate 5xx | SDK middleware counter | Count since last heartbeat |
| PG pool active | pg pool stats | Count |
| PG pool idle | pg pool stats | Count |
| PG query time avg | SDK query wrapper | Milliseconds |
| Mongo active connections | mongoose stats | Count |
| Mongo query time avg | SDK query wrapper | Milliseconds |
| Redis connected | ioredis status | Boolean |

**Alerting rules (configurable per project in portal):**
- CPU > 80% for 3 consecutive heartbeats → Warning alert
- CPU > 95% for 2 consecutive heartbeats → Critical alert
- Error rate 5xx > 5% over 1 minute → Critical alert
- No heartbeat for 90 seconds → Offline alert
- PG pool > 90% utilized → Warning alert

Alerts delivered to: Slack webhook (configured per project) and in-portal notification centre.

---

### Module 5 — Logging Engine

**Purpose:** Centralized log collection, storage, and search.

**Flow:** SDK → `POST /sdk/logs` → Platform API → Loki

**Log retention:** 30 days hot (searchable in portal), 90 days cold (downloadable archive).

**Portal log viewer features:**
- Real-time stream (auto-refresh every 5 seconds)
- Filter by: project, environment, log level, service instance, time range
- Full-text search within log message
- Each log line shows: timestamp, level (colour-coded), service, environment, commit SHA, message, structured fields
- Download filtered logs as JSON or CSV

**Error tracking:** Logs at ERROR level are also written to a separate `errors` collection in MongoDB with deduplication. The portal shows an "Errors" tab per project with grouped error types, first seen, last seen, and occurrence count.

---

### Module 6 — Config Engine

**Purpose:** Runtime configuration and feature flags served to services via SDK.

**Config hierarchy:**
```
Global  →  Project  →  Environment  →  Instance
(lowest priority)                (highest priority)
```

**Portal config editor:**
- Table view: key, value, environment, last changed by, last changed at
- Edit inline — click value to edit
- Diff view: see what changes between environments
- JSON import/export for bulk updates

**Cache behaviour:**
- SDK caches all config values on init and refreshes every 30 seconds
- If platform is unreachable, cached values are used indefinitely until platform returns
- Instance-level overrides are one-time (used for debugging a specific pod, not persisted across restarts)

**Feature flags** are a subset of config — boolean values that the SDK interprets:
```javascript
if (caps.config('feature.new_certificate_ui')) {
  // show new UI
}
```

---

### Module 7 — Storage Engine

**Purpose:** Provider-independent file storage with CDN delivery.

**Supported providers:**
- Google Drive (certificates, documents)
- AWS S3 (media, large files)
- MinIO (internal uploads, self-hosted)
- Local storage (temp files, development only)

**Upload flow (Signed URL strategy):**
```
1. Service calls caps.storage.upload(file, { category: 'certificates' })
2. SDK calls POST /storage/upload-url on Platform API
3. Platform determines provider from routing config (Google Drive for 'certificates')
4. Platform generates a signed upload URL from the provider
5. SDK uploads directly from client to provider (bypasses Platform API — reduces load)
6. SDK notifies Platform of successful upload: POST /storage/confirm
7. Platform stores file metadata in `files` table
8. SDK returns file ID and metadata to service
```

**CDN routing:**
```
Client request for file
  → Cloudflare CDN (cache hit → serve directly)
  → Cache miss → Storage Gateway (Platform API)
  → Storage Gateway fetches from provider
  → Returns to Cloudflare (cached for next request)
  → Served to client
```

**Storage analytics per project:**
- Total files count
- Total storage used (per provider)
- Upload count per day (last 30 days)
- Most accessed files
- Quota utilization bar (configurable quota per project, enforced by SDK)

---

### Module 8 — Bootstrap Engine

**Purpose:** Automates adding fresh machines to the CAPS Kubernetes cluster.

**Target:** Fresh VPS/bare-metal nodes joining the existing KVM8-hosted cluster. KVM8 is the permanent master. New nodes are workers.

**Bootstrap script entry point:**
```bash
curl https://platform.capskengeri.com/bootstrap/get | bash -s -- --token <join-token> --master <master-ip>
```

**What bootstrap installs on a fresh node:**
- Docker (specific pinned version)
- Kubernetes kubelet + kubeadm (matching master version exactly)
- Node joins cluster via `kubeadm join`
- Node labels applied (role, environment, region)
- Prometheus node exporter installed (node metrics immediately visible in Grafana)
- Loki log collector configured
- MinIO storage configured if node is designated a storage node

**Bootstrap history:** Every bootstrap job logged in portal under Infrastructure → Bootstrap. Shows: node IP, join time, installed components, success/failure, logs.

**Idempotent:** Running bootstrap on a node already in the cluster detects the existing installation and exits safely with a status report, not an error.

---

### Module 9 — CI/CD Engine

**Purpose:** Generates and manages GitLab CI/CD pipeline configs and Kubernetes manifests for all CAPS projects.

**Generated artifacts per project:**
- `.gitlab-ci.yml` — full pipeline with stages: lint, test, build, deploy-preview, deploy-staging, deploy-production
- `Dockerfile` — templated by project type (Node.js, Angular, Python)
- `helm/` directory — Helm chart with values files per environment
- `k8s/` directory — Kubernetes Deployment, Service, Ingress manifests

**Pipeline stages:**
```
lint → test → build → [branch is feature/*] → deploy-preview
                    → [branch is develop]    → deploy-staging
                    → [branch is main]       → deploy-production (manual gate)
```

Production deployments require a manual approval step in GitLab. The "deploy-production" job is `when: manual`. Tech Leads and DevOps can trigger it. Developers cannot.

**Regeneration:** If a project's stack changes (e.g., adding MongoDB), DevOps can trigger CI/CD Engine to regenerate manifests. Changes are proposed as a GitLab MR, not applied directly.

---

### Module 10 — Database Connection Engine

**Purpose:** SDK-managed database connections. Services must never instantiate database drivers directly.

**Connection lifecycle:**

| Stage | What happens |
|---|---|
| Init | SDK calls `/sdk/db-credentials`, Platform proxies to Infisical, credentials returned |
| Connect | SDK establishes pools: PG (pool size 10 default), Mongo (pool size 5), Redis (single client) |
| Health check | Every 15s: test query/ping per DB, result included in heartbeat |
| Failure | Exponential backoff retry: 1s, 2s, 4s, 8s, 16s, max 60s. Non-blocking. |
| Reconnect | Automatic on connection drop |
| Shutdown | SIGTERM → drain pools → close connections → exit |

**Pool size configuration:** Default pool sizes are SDK defaults. Override via `caps.config('db.postgres.pool_size')` in the portal — no redeploy required.

**Credential rotation:** If Infisical rotates a credential, the SDK detects connection failure, re-fetches credentials from Platform API, and reconnects. Services experience zero downtime.

---

## 9. Database Schema

### PostgreSQL Tables

**projects**
```
id              UUID PRIMARY KEY
name            VARCHAR(100) NOT NULL UNIQUE
stack           VARCHAR(50)  (nodejs, angular, python, static)
clickup_list_id VARCHAR(50)
gitlab_repo_url TEXT
created_by      UUID REFERENCES users(id)
created_at      TIMESTAMP DEFAULT NOW()
deleted_at      TIMESTAMP NULL
```

**environments**
```
id          UUID PRIMARY KEY
project_id  UUID REFERENCES projects(id)
name        VARCHAR(50)  (preview, staging, production)
namespace   VARCHAR(100)
domain      VARCHAR(200)
created_at  TIMESTAMP DEFAULT NOW()
```

**deployments**
```
id               UUID PRIMARY KEY
project_id       UUID REFERENCES projects(id)
environment_id   UUID REFERENCES environments(id)
version          VARCHAR(100)
branch           VARCHAR(200)
commit_sha       VARCHAR(40)
image_tag        VARCHAR(200)
status           VARCHAR(50)  (pending, building, deploying, deployed, failed, rolled-back, terminated, expired)
deployed_by      UUID REFERENCES users(id)
clickup_task_id  VARCHAR(50) NULL
preview_url      TEXT NULL
deployed_at      TIMESTAMP
terminated_at    TIMESTAMP NULL
```

**clickup_task_links**
```
id               UUID PRIMARY KEY
clickup_task_id  VARCHAR(50) NOT NULL
deployment_id    UUID REFERENCES deployments(id)
project_id       UUID REFERENCES projects(id)
branch           VARCHAR(200)
linked_at        TIMESTAMP DEFAULT NOW()
```

**service_registrations**
```
id               UUID PRIMARY KEY
project_id       UUID REFERENCES projects(id)
environment_id   UUID REFERENCES environments(id)
hostname         VARCHAR(200)
ip_address       VARCHAR(50)
version          VARCHAR(100)
branch           VARCHAR(200)
commit_sha       VARCHAR(40)
infisical_project VARCHAR(100)
infisical_env    VARCHAR(50)
env_keys         TEXT[]
db_types         TEXT[]
status           VARCHAR(20)  (online, degraded, offline)
last_seen        TIMESTAMP
registered_at    TIMESTAMP DEFAULT NOW()
```

**project_configs**
```
id          UUID PRIMARY KEY
project_id  UUID REFERENCES projects(id) NULL  (NULL = global)
environment VARCHAR(50) NULL  (NULL = all environments)
key         VARCHAR(200) NOT NULL
value       TEXT
changed_by  UUID REFERENCES users(id)
changed_at  TIMESTAMP DEFAULT NOW()
```

**files**
```
id           UUID PRIMARY KEY
project_id   UUID REFERENCES projects(id)
provider     VARCHAR(50)  (google-drive, s3, minio, local)
bucket       VARCHAR(200)
storage_key  TEXT
filename     VARCHAR(500)
content_type VARCHAR(100)
size_bytes   BIGINT
category     VARCHAR(100)
cdn_url      TEXT NULL
uploaded_by  UUID REFERENCES service_registrations(id)
uploaded_at  TIMESTAMP DEFAULT NOW()
deleted_at   TIMESTAMP NULL
```

**alerts**
```
id          UUID PRIMARY KEY
project_id  UUID REFERENCES projects(id)
type        VARCHAR(50)  (cpu_high, error_rate, offline, pool_exhausted)
severity    VARCHAR(20)  (warning, critical)
config      JSONB
enabled     BOOLEAN DEFAULT TRUE
created_at  TIMESTAMP DEFAULT NOW()
```

**db_connections**
```
id              UUID PRIMARY KEY
registration_id UUID REFERENCES service_registrations(id)
db_type         VARCHAR(20)  (postgres, redis, mongo)
pool_size       INTEGER
active_count    INTEGER
idle_count      INTEGER
status          VARCHAR(20)  (connected, degraded, disconnected)
last_heartbeat  TIMESTAMP
```

**users**
```
id           UUID PRIMARY KEY
email        VARCHAR(200) UNIQUE
name         VARCHAR(200)
role         VARCHAR(20)  (developer, tech_lead, devops)
gitlab_id    VARCHAR(100)
created_at   TIMESTAMP DEFAULT NOW()
last_login   TIMESTAMP
```

**audit_logs**
```
id          UUID PRIMARY KEY
user_id     UUID REFERENCES users(id)
action      VARCHAR(100)  (deploy, rollback, config_change, project_create, etc.)
target_type VARCHAR(50)
target_id   UUID
metadata    JSONB
performed_at TIMESTAMP DEFAULT NOW()
```

### MongoDB Collections

**logs**
```json
{
  "_id": "ObjectId",
  "project_id": "uuid",
  "environment": "staging",
  "branch": "feature/CU-842",
  "commit_sha": "a3f92c1",
  "hostname": "caps-auto-backend-pod-xyz",
  "level": "ERROR",
  "message": "DB query failed",
  "fields": { "error": "connection timeout", "query": "SELECT..." },
  "timestamp": "ISODate"
}
TTL index: timestamp, expire after 30 days
```

**metrics_raw**
```json
{
  "_id": "ObjectId",
  "registration_id": "uuid",
  "project_id": "uuid",
  "environment": "production",
  "cpu_pct": 12.4,
  "memory_mb": 256,
  "heap_mb": 180,
  "uptime_s": 86400,
  "request_count": 142,
  "avg_response_ms": 45,
  "p95_response_ms": 120,
  "errors_4xx": 3,
  "errors_5xx": 0,
  "db_health": { "postgres": "connected", "redis": "connected" },
  "timestamp": "ISODate"
}
TTL index: timestamp, expire after 7 days
```

**errors**
```json
{
  "_id": "ObjectId",
  "project_id": "uuid",
  "environment": "staging",
  "error_type": "ConnectionTimeout",
  "message": "DB query failed: connection timeout",
  "stack_hash": "sha256 of stack trace",
  "first_seen": "ISODate",
  "last_seen": "ISODate",
  "occurrence_count": 14
}
```

**sdk_events**
```json
{
  "_id": "ObjectId",
  "event": "registration | heartbeat | config_fetch | log_batch",
  "registration_id": "uuid",
  "project_id": "uuid",
  "payload_summary": {},
  "timestamp": "ISODate"
}
TTL index: timestamp, expire after 3 days
```

---

## 10. API Reference

### Authentication

All API endpoints require a Bearer token. SDK endpoints use a project-scoped SDK token generated at project creation and stored in Infisical. Portal endpoints use user JWT tokens from GitLab OAuth.

### Project Endpoints

| Method | Endpoint | Role | Description |
|---|---|---|---|
| POST | /projects | Tech Lead, DevOps | Create new project |
| GET | /projects | All | List projects (scoped by role) |
| GET | /projects/:id | All | Get project details |
| PATCH | /projects/:id | DevOps | Update project settings |
| DELETE | /projects/:id | DevOps | Soft-delete project |

### Deployment Endpoints

| Method | Endpoint | Role | Description |
|---|---|---|---|
| POST | /deploy | CI/CD, DevOps | Trigger a deployment |
| POST | /rollback | Tech Lead, DevOps | Roll back to previous version |
| POST | /deploy/restart | DevOps | Restart pods without new image |
| GET | /deployments/:projectId | All | Deployment history |
| PATCH | /deployments/:id/scale | DevOps | Scale replica count |

### SDK Endpoints

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | /sdk/register | SDK token | Auto-registration on boot |
| POST | /sdk/heartbeat | SDK token | Metrics + DB health heartbeat |
| POST | /sdk/logs | SDK token | Batch log forwarding |
| GET | /sdk/config | SDK token | Fetch runtime config for project+env |
| GET | /sdk/db-credentials | SDK token | Fetch DB credentials from Infisical |

### Storage Endpoints

| Method | Endpoint | Role | Description |
|---|---|---|---|
| POST | /storage/upload-url | SDK token | Generate signed upload URL |
| POST | /storage/confirm | SDK token | Confirm upload complete |
| DELETE | /storage/file/:id | SDK token, DevOps | Delete a file |
| GET | /storage/file/:id | All | Get file metadata and CDN URL |
| GET | /storage/analytics/:projectId | Tech Lead, DevOps | Storage usage analytics |

### Config Endpoints

| Method | Endpoint | Role | Description |
|---|---|---|---|
| GET | /config/:projectId | All | Get config for project |
| POST | /config | Tech Lead, DevOps | Create config key |
| PATCH | /config/:id | Tech Lead, DevOps | Update config value |
| DELETE | /config/:id | DevOps | Delete config key |

### Integration Endpoints

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | /integrations/clickup/webhook | ClickUp secret | Receive ClickUp status change |
| GET | /integrations/clickup/status | DevOps | View ClickUp integration health |

### Bootstrap Endpoints

| Method | Endpoint | Role | Description |
|---|---|---|---|
| POST | /bootstrap/init | DevOps | Register new node bootstrap job |
| GET | /bootstrap/token | DevOps | Generate a one-time join token |
| GET | /bootstrap/history | DevOps | View bootstrap job history |
| GET | /bootstrap/nodes | DevOps | List all cluster nodes |

---

## 11. Bootstrap Engine

### Cluster Topology

```
KVM8 (Hostinger) — Kubernetes Master (permanent, never re-bootstrapped)
  │
  ├── Worker Node 1 (bootstrapped via engine)
  ├── Worker Node 2 (bootstrapped via engine)
  └── Worker Node N (bootstrapped via engine)
```

KVM8 runs the control plane components plus the CAPS Platform itself. Worker nodes run project workloads.

### Node Addition Flow

1. DevOps provisions a fresh VPS (any provider)
2. DevOps goes to Infrastructure → Bootstrap in the portal
3. Clicks "Add Node" — portal calls `GET /bootstrap/token` to generate a one-time join token (expires in 1 hour)
4. Portal displays a single curl command to run on the new node
5. DevOps SSHes into new node, runs the command
6. Bootstrap script installs dependencies, runs `kubeadm join`, applies labels
7. Node appears in portal under Infrastructure → Nodes within 2 minutes
8. Prometheus starts scraping node metrics automatically (via node exporter)

### Node Labels Applied

```
caps.io/role: worker
caps.io/environment: production | staging | preview | any
caps.io/region: in-south | in-west | etc.
caps.io/added-at: <timestamp>
```

Workloads can be scheduled to specific nodes using these labels via `nodeSelector` in Helm charts.

---

## 12. Repository Structure

```
caps-platform/
├── portal/                  Angular app
│   ├── src/app/
│   │   ├── views/
│   │   │   ├── overview/
│   │   │   ├── projects/
│   │   │   │   └── [id]/
│   │   │   │       ├── deployments/
│   │   │   │       ├── metrics/
│   │   │   │       ├── logs/
│   │   │   │       ├── config/
│   │   │   │       ├── storage/
│   │   │   │       └── environments/
│   │   │   ├── preview-urls/
│   │   │   ├── clickup/
│   │   │   └── infrastructure/   (DevOps only)
│   │   ├── guards/              RBAC route guards
│   │   └── services/            API clients
│
├── api/                     Next.JS app
│   ├── src/
│   │   ├── modules/
│   │   │   ├── projects/
│   │   │   ├── deployments/
│   │   │   ├── sdk/
│   │   │   ├── metrics/
│   │   │   ├── logging/
│   │   │   ├── config/
│   │   │   ├── storage/
│   │   │   ├── bootstrap/
│   │   │   ├── cicd/
│   │   │   └── integrations/
│   │   │       └── clickup/
│   │   ├── guards/              Auth + RBAC guards
│   │   └── common/
│
├── templates/
│   ├── ci/
│   │   ├── nodejs.gitlab-ci.yml
│   │   ├── angular.gitlab-ci.yml
│   │   └── python.gitlab-ci.yml
│   ├── docker/
│   │   ├── Dockerfile.nodejs
│   │   ├── Dockerfile.angular
│   │   └── Dockerfile.python
│   └── k8s/
│       ├── deployment.yaml
│       ├── service.yaml
│       ├── ingress.yaml
│       └── preview/
│           ├── deployment.yaml
│           ├── service.yaml
│           └── ingress.yaml
│
└── docs/

caps-sdk-node/               @caps/sdk-node npm package
├── src/
│   ├── index.ts             caps.init()
│   ├── database/            DB connection engine
│   ├── metrics/             Heartbeat + metrics collection
│   ├── logging/             Log wrapper + forwarder
│   ├── config/              Config fetch + cache
│   ├── storage/             Storage abstraction
│   └── registration/        Auto-registration
└── package.json

caps-sdk-python/             caps-sdk-python pip package
├── caps_sdk/
│   ├── __init__.py
│   ├── database.py
│   ├── metrics.py
│   ├── logging.py
│   ├── config.py
│   ├── storage.py
│   └── registration.py
└── setup.py

caps-bootstrap/              Bootstrap scripts
├── bootstrap.sh             Node join script
├── install/
│   ├── docker.sh
│   ├── kubernetes.sh
│   ├── prometheus-exporter.sh
│   └── loki-collector.sh
└── validate.sh              Post-bootstrap health check
```

---

## 13. Execution Roadmap

### Phase 0 — Foundation (Week 1, Full Team)

**Goal:** Everyone can develop against the platform locally. Nothing is "done" but everything is scaffolded.

- Monorepo setup with caps-platform, caps-sdk-node, caps-sdk-python, caps-bootstrap
- PostgreSQL schema migrations written and applied
- MongoDB collections and TTL indexes created
- Next.JS API skeleton with all modules stubbed (routes exist, return 201/200 with empty data)
- Angular portal skeleton with all routes and role guards wired
- GitLab private npm and pip registry configured for SDK packages
- Wildcard DNS for `*.preview.capskengeri.com` pointing to cluster ingress
- Wildcard TLS certificate provisioned (cert-manager or manual)

**Who does what:** Divide by module. Two engineers on API scaffold, two on portal scaffold, one on DB schema + migrations, one on DNS/TLS/K8s infra. Tech Lead reviews PRs daily.

---

### Phase 1 — MVP Core (Weeks 2–3)

**Goal:** Projects can be created, a deployment can be triggered, and the portal shows it.

- Project Engine: create, list, get project endpoints working end-to-end
- Deployment Engine: deploy + rollback wired to ArgoCD API
- Deployment history table in portal (read-only)
- User auth via GitLab OAuth, JWT issuance
- RBAC guards applied to all existing endpoints
- Basic portal overview page showing project cards with status

**Acceptance criteria:** A DevOps engineer creates a project in the portal, triggers a deploy, sees the deployment appear in history with correct status. A developer logging in sees only their projects.

---

### Phase 2 — SDK Core (Weeks 4–5)

**Goal:** One real CAPS project has the SDK installed and reporting to the platform.

- `@caps/sdk-node` published to GitLab package registry
- `caps.init()` auto-registration working end-to-end
- Heartbeat endpoint live, data writing to MongoDB metrics_raw
- Portal shows "Online / Offline" per service
- DB credentials fetch from Infisical via Platform API working
- One real project (caps-automation-backend) migrated to use SDK for DB connections

**Acceptance criteria:** caps-automation-backend boots, registers automatically, appears in portal as Online. Heartbeat data visible in MongoDB. DB connections working through SDK.

---

### Phase 3 — Preview Environments + ClickUp (Week 6)

**Goal:** git push to feature/* generates a live URL. ClickUp task gets the URL.

- GitLab CI template for preview deploys published
- Platform API `POST /deploy` handles preview environment type
- Kubernetes manifests applied to preview namespace
- Preview URL generation logic
- ClickUp webhook receiver live
- ClickUp comment poster live
- Preview TTL cleanup CronJob deployed
- Branch naming convention enforced in CI (reject non-conforming branches)

**Acceptance criteria:** Developer pushes feature/CU-999-test, preview URL appears at cu-999-test.preview.capskengeri.com within 5 minutes, ClickUp task CU-999 gets a comment with the URL.

---

### Phase 4 — Metrics Dashboard (Week 7)

**Goal:** Real-time metrics visible in portal for all SDK-registered services.

- Metrics Engine aggregation jobs
- Portal metrics tab with charts (CPU, memory, response time, error rate)
- Time range selector (1h, 6h, 24h)
- Alert configuration UI (per project)
- Slack webhook integration for alerts
- In-portal notification centre

---

### Phase 5 — Logging Engine (Week 8)

**Goal:** All logs searchable in portal.

- Log forwarding from SDK to Loki working
- Portal log viewer with filters and search
- Error tracking collection in MongoDB
- Portal errors tab per project with grouping and counts
- Log download (JSON, CSV)

---

### Phase 6 — Config Engine (Weeks 9–10)

**Goal:** `caps.config()` works and values are editable from the portal without redeployment.

- Config Engine endpoints live
- `caps.config()` in SDK fetching from platform and caching
- Portal config tab: view, create, edit, delete keys
- Per-environment overrides
- Config change history
- Feature flags as boolean config values

---

### Phase 7 — Storage Engine (Weeks 11–13)

**Goal:** `caps.storage.upload()` works across all providers.

- Storage Gateway in Platform API
- Signed URL generation for S3, MinIO, Google Drive
- SDK storage abstraction
- Storage routing config per project in portal
- CDN routing via Cloudflare
- Storage analytics tab in portal
- Quota enforcement

---

### Phase 8 — DB Connection Engine (Week 14)

**Goal:** All CAPS projects using SDK-managed DB connections.

- SDK DB connection pools fully hardened
- Credential rotation handling tested
- Exponential backoff tested
- All active CAPS projects migrated off raw drivers
- Pool size config via caps.config()

---

### Phase 9 — Bootstrap Engine (Weeks 15–17)

**Goal:** Adding a new node to the cluster is a portal UI action, not a manual SSH session.

- Bootstrap script written and tested on a fresh node
- One-time join token generation
- Bootstrap job history in portal
- Node list view with labels and status
- Post-bootstrap validation script

---

### Phase 10 — CI/CD Engine (Weeks 18–19)

**Goal:** New projects get generated CI/CD configs, not hand-written ones.

- Template generator for Node.js, Angular, Python
- Generated files proposed as GitLab MR
- Manual production gate wired
- Staging → Production promotion flow with Tech Lead approval

---

## 14. Critical Design Principles

1. **SDK must never block service execution.** Every outbound SDK call is fire-and-forget. No `await` on platform calls in the hot path.

2. **SDK must fail silently.** If the platform is unreachable, the service runs normally. Errors are logged internally by the SDK, never surfaced to the service.

3. **Config must be cached.** `caps.config()` never makes a network call synchronously. Values are refreshed in the background. A platform outage does not break config reads.

4. **Database connections are SDK-owned.** Services must not import pg, mongoose, ioredis, or any database driver. If a PR adds a direct DB import, it fails CI lint.

5. **Credentials never leave Infisical unproxied.** The SDK never calls Infisical directly. It always goes through the Platform API, which enforces access control before proxying to Infisical.

6. **Preview environments are throwaway.** They have resource quotas, TTLs, and cleanup automation. They are never promoted directly to staging — code goes through a proper PR and branch merge.

7. **Infrastructure must be declarative.** All Kubernetes resources are managed via Helm charts checked into Git. No manual kubectl apply in production.

8. **New server setup is a portal action.** SSHing into a node to configure it manually is not acceptable after Phase 9. Bootstrap scripts handle everything.

9. **Storage is provider-independent.** Services never call S3 SDK, Google Drive API, or MinIO client directly. All storage goes through `caps.storage.*`.

10. **Every destructive action is audit-logged.** Deploy, rollback, delete project, config change, node bootstrap — all recorded with user, timestamp, and full metadata.

---

## 15. Open Questions & Decisions Log

| # | Question | Status | Decision / Notes |
|---|---|---|---|
| 1 | Which GitLab tier? Self-hosted or GitLab.com? | Open | Affects pipeline trigger API behaviour |
| 2 | ClickUp workspace ID and list IDs for webhook scope | Open | DevOps to configure during Phase 3 |
| 3 | Storage quota per project — what are the limits? | Open | Need to define before Storage Engine (Phase 7) |
| 4 | Slack workspace for alert webhooks | Open | One global channel or per-project? |
| 5 | MongoDB Atlas or self-hosted Mongo on cluster? | Open | Self-hosted assumed; confirm before Phase 2 |
| 6 | SDK version pinning policy — auto-update or manual? | Open | Recommend explicit version in each project's package.json |
| 7 | Infisical self-hosted or Infisical Cloud? | Open | Affects credential fetch latency and reliability SLA |
| 8 | Preview environment resource quota values | Open | CPU limit, memory limit, max replicas per preview pod |
| 9 | Log retention policy — 30 days hot enough? | Open | Confirm with Tech Leads before Phase 5 |
| 10 | Portal SSO — GitLab OAuth only or also Google? | Open | GitLab assumed; CAPS members have GitLab accounts |