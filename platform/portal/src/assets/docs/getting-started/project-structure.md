# Project Structure

Platform is a monorepo containing the backend API, admin dashboard, four SDKs, a cluster bootstrap tool, and documentation.

```
platform/
├── api/                        # Express + TypeORM (PostgreSQL) + Mongoose (MongoDB)
│   ├── src/
│   │   ├── config/             # DB connection, Mongoose setup, permission matrix, route registration
│   │   ├── entities/           # TypeORM entities: User, Project, Deployment, Environment, Secret, etc.
│   │   ├── lib/                # k8s client (kubectl wrapper), Loki logger, preview-decay scheduler
│   │   ├── middleware/         # JWT authentication, RBAC enforcement, audit-log capture
│   │   ├── routes/             # Express route handlers for auth, projects, deployments, secrets, etc.
│   │   ├── schemas/            # Mongoose schemas: Log, Metric, BugReport, DeploymentEvent, AuditEntry
│   │   └── server.ts           # Application entry point — Express bootstrap + middleware registration
│   ├── tests/
│   │   ├── unit/               # Unit tests for services, helpers, and utilities
│   │   └── integration/        # Integration tests: auth, projects, deployments, secrets, webhooks
│   ├── sync-db.ts              # Database sync script — runs migrations and seeds demo data
│   └── package.json
├── portal/                     # Angular 19 admin dashboard
│   ├── src/app/
│   │   ├── pages/              # All page components: Login, Dashboard, Projects, Deployments, Secrets, etc.
│   │   ├── services/           # API service (HTTP client wrappers), Auth service (JWT management)
│   │   ├── layout/             # Sidebar navigation, header bar, page shell
│   │   └── guards/             # Route guards that enforce authentication and RBAC
│   └── package.json
├── sdk-node/                   # Node.js SDK — published as @mpratyush54/sdk-node
│                               #   - PlatformClient: metrics tracking, structured logging, bug reporting
│                               #   - Express middleware for auto-instrumentation
│                               #   - DB helpers: MongoClient, PostgresPool, RedisClient wrappers
│                               #   - captureConsole() for automatic console.log interception
├── sdk-python/                 # Python SDK — published as platform-sdk-python
│                               #   - PlatformClient: metrics, logging, bug reporting
│                               #   - DB helper mixins: MongoClient, PostgresPool, RedisClient
├── sdk-react/                  # React SDK — published as @mpratyush54/sdk-react
│                               #   - PlatformProvider context provider
│                               #   - usePlatform, useBugReporter hooks
│                               #   - ErrorBoundary, BugReporterWidget components
├── sdk-angular/                # Angular SDK — published as @mpratyush54/sdk-angular
│                               #   - PlatformModule.forRoot() configuration
│                               #   - PlatformHttpInterceptor for automatic metrics
│                               #   - PlatformErrorHandler, BugReporterComponent
├── platform-bootstrap/         # Cluster bootstrap for production k3s deployments
│   ├── bootstrap.sh            # Full k3s cluster setup: installs k3s, Helm, ArgoCD, cert-manager, etc.
│   ├── patches/                # Helm value overrides for Platform API, Portal, MongoDB, PostgreSQL
│   └── tests/                  # Post-deployment verification scripts (curl-based smoke tests)
└── docs/                       # This documentation
    ├── getting-started/        # Setup guides, first project, SDK quickstarts
    ├── architecture/           # System design, data flow, auth flow, network topology
    ├── deployment/             # Bootstrap, rebuild, scaling, SSL, secrets, backup
    ├── api-reference/          # Platform API endpoints, SDKs, configuration docs
    ├── guides/                 # Authentication, secrets, monitoring, preview envs, testing
    └── troubleshooting/        # Solutions to known deployment and build issues
```

## Directory Relationships

| Directory | Depends On | Purpose |
|---|---|---|
| `api` | PostgreSQL, MongoDB, Redis | Central backend — all SDKs and the portal communicate with the API |
| `portal` | `api` (via REST) | Admin dashboard for managing projects, deployments, and secrets |
| `sdk-node` | `api` (via REST) | Instrument Node.js services with metrics, logs, and bug reports |
| `sdk-python` | `api` (via REST) | Instrument Python services with metrics, logs, and bug reports |
| `sdk-react` | `api` (via REST) | Instrument React frontends with error boundaries and bug reporting |
| `sdk-angular` | `api` (via REST) | Instrument Angular frontends with HTTP interceptors and error handlers |
| `platform-bootstrap` | `api`, `portal` | Deploys the full stack onto a k3s cluster |

## Key Files

| File | Purpose |
|---|---|
| `api/src/server.ts` | Express app bootstrap — registers middleware, routes, and starts the HTTP server |
| `api/src/config/permissions.ts` | Role-based permission matrix — defines what each role can access |
| `api/src/lib/preview-decay.ts` | Scheduler that automatically cleans up stale preview environments |
| `portal/src/app/pages/` | All UI views — each page maps to a route in the Angular router |
| `platform-bootstrap/bootstrap.sh` | Single script that provisions a production-ready k3s cluster |
