# Testing

The Platform project includes multiple layers of testing: unit tests for the API, integration tests for API routes, deployment tests for the Kubernetes cluster, external route tests, and SDK package tests.

---

## Unit Tests (Jest)

### Run

```bash
cd platform/api
npm run test:unit
```

### Configuration

Defined in `platform/api/jest.config.js`:

```javascript
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  transformIgnorePatterns: ['node_modules/(?!@kubernetes/client-node)/'],
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' },
};
```

### Test Structure

```
platform/api/tests/
├── unit/
│   ├── config/
│   ├── entities/
│   ├── lib/
│   ├── middleware/
│   └── routes/
└── integration/
    ├── api.test.ts
    ├── auth-users.test.ts
    ├── frontend-backend.test.ts
    ├── oauth.test.ts
    ├── projects-deployments.test.ts
    ├── sdk-api.test.ts
    ├── sdk-bootstrap-edge.test.ts
    └── secrets-settings.test.ts
```

### Coverage

Collected from `src/**/*.ts` (excluding `server.ts`, `config/database.ts`, `config/mongoose.ts`, `config/kubernetes.ts`).

```bash
# Run with coverage
npx jest --coverage
```

---

## Integration Tests

### Run

```bash
cd platform/api
npm run test:integration
```

### Test Files

| File | What It Tests |
|---|---|
| `api.test.ts` | General API endpoints, health check |
| `auth-users.test.ts` | Login flow, user CRUD, role assignment |
| `projects-deployments.test.ts` | Project CRUD, deployment lifecycle |
| `secrets-settings.test.ts` | Secret CRUD, encryption, export, SMTP settings |
| `oauth.test.ts` | OAuth2 authorization code flow, token exchange |
| `sdk-api.test.ts` | SDK registration, heartbeat, config injection |
| `sdk-bootstrap-edge.test.ts` | Edge cases: missing fields, invalid tokens, concurrency |
| `frontend-backend.test.ts` | Portal → API connectivity |

---

## Deployment Tests

### Shell Test Suite

**File:** `platform-bootstrap/tests/test-deployment.sh`

A comprehensive bash-based test suite that verifies the entire deployed platform from within the cluster. Runs **28 tests** across 12 categories.

```bash
# Run from the cluster
sudo ./platform-bootstrap/tests/test-deployment.sh <domain>
```

| # | Category | Tests | What It Verifies |
|---|---|---|---|
| 1 | Infrastructure Pods | 9 | All namespaces have pods in Running state (no CrashLoopBackOff) |
| 2 | Node Status | 1 | All Kubernetes nodes are Ready |
| 3 | HTTP Routes | 6 | Ingress returns expected status codes for `/`, `/api/health`, `/grafana`, `/argocd`, `/minio`, `/portainer` |
| 4 | API Health | 1 | `/api/health` returns valid JSON with `status` field |
| 5 | Database Connectivity | 3 | PostgreSQL (`pg_isready`), MongoDB (`db.runCommand({ping:1})`), Redis (`PING`) |
| 6 | Storage | 1 | MinIO pod is accessible |
| 7 | Monitoring | 1 | Grafana returns HTTP 200/302 |
| 8 | Secrets | 1 | Platform Kubernetes Secret exists |
| 9 | Certificates | 1 | Let's Encrypt certificate is issued and Ready |
| 10 | DNS / Networking | 1 | IPv4 precedence configured for DNS resolution |
| 11 | Portainer | 1 | Portainer pod is Running |
| 12 | API Connectivity | 1 | Portal can reach API backend via internal service |

### External Test Suite

**File:** `platform-bootstrap/tests/test-external.ps1`

A Windows PowerShell test suite for running from an external machine. Tests **7 routes** via HTTPS.

```powershell
# Run from any Windows machine
.\platform-bootstrap\tests\test-external.ps1
```

| # | Route | Expected Status |
|---|---|---|
| 1 | `https://{DOMAIN}/` | 200 |
| 2 | `https://{DOMAIN}/api/health` | 200 |
| 3 | `https://{DOMAIN}/grafana` | 302 (redirect) |
| 4 | `https://{DOMAIN}/argocd` | 307 (redirect) |
| 5 | `https://{DOMAIN}/minio` | 200 |
| 6 | `https://{DOMAIN}/portainer` | 200 |
| 7 | `https://{DOMAIN}/api/health` | Valid JSON body |

---

## SDK Tests

### Node.js SDK

```bash
cd sdk-node
npm test
```

| Directory | Tests | Description |
|---|---|---|
| `tests/unit/` | `config.test.ts`, `heartbeat.test.ts`, `logger.test.ts`, `registration.test.ts`, `storage.test.ts` | Unit tests for all SDK modules |
| `tests/unit/db/` | `postgres.test.ts`, `mongo.test.ts` | Database connection tests |
| `tests/integration/` | `client.test.ts` | End-to-end integration test |

### Python SDK

```bash
cd sdk-python
pytest
```

| File | Description |
|---|---|
| `tests/test_postgres.py` | PostgreSQL connection via SDK |
| `tests/test_mongo.py` | MongoDB connection via SDK |
| `tests/test_redis.py` | Redis connection via SDK |
| `tests/test_integration.py` | Full integration test |
| `tests/test_caps_client.py` | Legacy CAPS client compatibility |

Pytest configured in `pytest.ini`.

### React SDK

```bash
cd sdk-react
npm test
```

Tests for `PlatformProvider`, `PlatformContext`, `ErrorBoundary`, and `BugReporter` components.

### Angular SDK

```bash
cd sdk-angular
npm test
```

Tests for `PlatformModule`, `HttpInterceptor`, `ErrorHandler`, and `BugReporterComponent`.
