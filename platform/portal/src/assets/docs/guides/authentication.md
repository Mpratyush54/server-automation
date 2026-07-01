# Authentication & Authorization

## JWT Token Format

The Platform API issues JSON Web Tokens (JWT) for authentication. Tokens are signed with the `JWT_SECRET` environment variable using **HS256** (HMAC-SHA256) for regular logins and **RS256** (RSA-SHA256) for OIDC flows.

### Payload Structure

```json
{
  "id": "11111111-1111-1111-1111-111111111111",
  "email": "john@dev.io",
  "name": "John Dev",
  "role": "developer",
  "iat": 1719000000,
  "exp": 1719086400
}
```

| Claim | Description |
|---|---|
| `id` | User UUID (Primary Key) |
| `email` | User email address |
| `name` | Display name |
| `role` | Role preset: `admin`, `devops`, `tech_lead`, `developer`, `viewer` |
| `iat` | Issued-at timestamp (UNIX epoch) |
| `exp` | Expiration timestamp — defaults to **24 hours** |

### Expiry

Token lifetime is hard-coded at **24 hours** (`expiresIn: '24h'`). There is no refresh token mechanism — clients must re-authenticate after expiry.

```typescript
// platform/api/src/routes/auth.ts:50-54
const token = jwt.sign(
  { id: user.id, email: user.email, name: user.name, role: user.role },
  JWT_SECRET,
  { expiresIn: '24h' }
);
```

---

## Email-Only Login (No Password)

The login endpoint accepts **only an email address** — no password is required.

### Design Rationale

1. **Internal PaaS context** — Platform is designed for internal/private deployments behind a VPN or OAuth2 proxy. The email itself is the identity.
2. **SSO-first architecture** — Authentication is delegated to OAuth2/OIDC providers (see OIDC/SSO section). The email-only login exists for development convenience.
3. **Simplified user onboarding** — No password management, no reset flows, no hashing overhead.
4. **Demo-friendly** — Four demo users (`admin@dev.io`, `devops@dev.io`, `sarah@dev.io`, `john@dev.io`) can be seeded instantly.

### API

```http
POST /api/auth/login
Content-Type: application/json

{"email": "john@dev.io"}
```

**Response:**

```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "user": {
    "id": "11111111-1111-1111-1111-111111111111",
    "email": "john@dev.io",
    "name": "John Dev",
    "role": "developer"
  }
}
```

> **Security Advisory:** In production, ensure the platform is not exposed to the public internet without an OAuth2 proxy or network restriction. See [OIDC/SSO](#oidcsso) below.

---

## Role Presets

Five built-in role presets are defined in `platform/api/src/config/permissions.ts`. Each preset is a set of permission strings.

| Role | Description | Typical User |
|---|---|---|
| `admin` | Unrestricted access to every permission | Platform administrators |
| `devops` | Full infrastructure, user, secret, and deployment management | DevOps engineers |
| `tech_lead` | Project, deployment, config, and secret access (no user mgmt) | Senior developers managing projects |
| `developer` | Read project info, trigger deployments, view logs | Application developers |
| `viewer` | Read-only view of projects, deployments, logs, metrics | Stakeholders, read-only access |

### Exact Permissions Per Preset

#### `admin`

All 48 permissions defined in the system (see [Permissions Reference](../api-reference/configuration/permissions.md)).

#### `devops`

```
users.list, users.create, users.update, users.read-profile
projects.list, projects.create, projects.update, projects.delete, projects.read
deployments.trigger, deployments.terminate, deployments.restart, deployments.scale, deployments.read, deployments.rollback
databases.provision, databases.backup, databases.restore, databases.delete, databases.create-connection, databases.delete-connection, databases.read
config.read, config.update, config.delete, config.manage-feature-flags
secrets.list, secrets.read, secrets.reveal, secrets.create, secrets.update, secrets.delete, secrets.export, secrets.import, secrets.rollback
alerts.list, alerts.create, alerts.update, alerts.delete
logs.read, logs.search, metrics.read, metrics.read-rpm
settings.smtp.read, settings.smtp.manage, settings.storage.read, settings.storage.manage
cluster.read, cluster.manage, cluster.pods.read, cluster.pods.delete
cicd.register-webhook, cicd.read
bootstrap.init, bootstrap.read
audit.read
sdk.send-logs, sdk.send-metrics, sdk.send-bug-reports
auth.login, auth.manage-tokens
```

#### `tech_lead`

```
users.list, users.read-profile
projects.list, projects.create, projects.update, projects.read
deployments.trigger, deployments.terminate, deployments.read, deployments.rollback
databases.read
config.read, config.update, config.manage-feature-flags
secrets.list, secrets.read, secrets.reveal, secrets.create, secrets.update, secrets.export, secrets.import
alerts.list, alerts.create, alerts.update
logs.read, logs.search, metrics.read, metrics.read-rpm
cicd.read
audit.read
auth.login
```

#### `developer`

```
users.read-profile
projects.list, projects.read
deployments.trigger, deployments.read
databases.read
config.read
alerts.list
logs.read, metrics.read
auth.login
```

#### `viewer`

```
projects.list, projects.read
deployments.read
logs.read
metrics.read
auth.login
```

---

## Custom Roles

Custom roles extend the preset system. A user can have **both** a role preset and a custom role — permissions are merged.

### Creating a Role via API

```http
POST /api/roles
Authorization: Bearer <token>
Content-Type: application/json

{
  "name": "database-admin",
  "description": "Can manage all database operations",
  "permissions": [
    "databases.provision",
    "databases.backup",
    "databases.restore",
    "databases.delete",
    "databases.create-connection"
  ]
}
```

**Response:**

```json
{
  "id": "a1b2c3d4-...",
  "name": "database-admin",
  "description": "Can manage all database operations",
  "permissions": ["databases.provision", "databases.backup", ...],
  "isSystem": false,
  "isActive": true,
  "createdAt": "2025-06-21T12:00:00Z"
}
```

### Assigning to a User

```http
PATCH /api/users/:id/role
Authorization: Bearer <token>
Content-Type: application/json

{
  "role": "developer",
  "roleId": "a1b2c3d4-..."
}
```

The `role` field sets the preset (`developer`). The `roleId` field links the custom role. Permission cache is automatically cleared for that user.

### Permission Merging

When resolving permissions, the system merges:

1. **Preset permissions** — from `ROLE_PRESETS[user.role]`
2. **Custom role permissions** — from the `Role` entity linked via `user.roleId`

```typescript
// platform/api/src/middleware/auth.ts:35-50
const preset = ROLE_PRESETS[user.role];
if (preset) { for (const p of preset) perms.add(p); }

if (user.roleId) {
  const role = await ds.getRepository(Role).findOne({ where: { id: user.roleId } });
  if (role && role.permissions) { for (const p of role.permissions) perms.add(p); }
}
```

The merged set is cached for 60 seconds (see [Permission Cache Invalidation](#permission-cache-invalidation)).

### Viewing a User's Effective Permissions

```http
GET /api/users/:id/permissions
Authorization: Bearer <token>
```

### Editing / Deleting Custom Roles

```http
PUT    /api/roles/:id     # Update name, description, permissions
DELETE /api/roles/:id     # Delete (unassigns all users, clears their cache)
```

> System roles (`isSystem: true`) cannot be modified or deleted.

---

## OIDC / SSO

Platform implements a built-in OAuth2 / OpenID Connect provider for single sign-on across services.

### Architecture

```
┌──────────────┐     ┌──────────────────┐     ┌──────────────────┐
│   Browser    │────→│  OAuth2 Proxy    │────→│  Platform API    │
│   (Client)   │     │  (ingress-auth)  │     │  /api/oauth/*    │
└──────────────┘     └──────────────────┘     └──────────────────┘
                            │                          │
                            │                          │
                     ┌──────▼──────┐           ┌───────▼───────┐
                     │   Grafana   │           │   Portainer   │
                     │  (OIDC Rely)│           │  (OIDC Rely)  │
                     └─────────────┘           └───────────────┘
```

### OAuth2 Proxy Integration

The deployment includes **oauth2-proxy** as a sidecar for ingress-level authentication. Services that need SSO (Grafana, Portainer) use it as a reverse proxy.

Configuration in `platform-bootstrap/manifests/oauth2-proxy-values.yaml`:

```yaml
config:
  clientID: "oauth2-proxy"
  clientSecret: "<placeholder>"
  cookieSecret: "<generated>"
  configFile: |
    provider = "oidc"
    oidc_issuer_url = "https://{DOMAIN}/api/oauth"
    scope = "openid profile email groups"
    redirect_url = "https://{DOMAIN}/oauth2/callback"
    cookie_expire = "24h"
    cookie_refresh = "5m"
    pass_access_token = true
    pass_authorization_header = true
    set_authorization_header = true
```

### Grafana SSO

Grafana is configured as an OIDC relying party in `platform-bootstrap/manifests/grafana-values.yaml`:

```ini
[auth.generic_oauth]
enabled = true
name = Platform
allow_sign_up = true
client_id = grafana
client_secret = grafana-secret-placeholder
scopes = openid profile email groups
auth_url = https://{DOMAIN}/api/oauth/authorize
token_url = https://{DOMAIN}/api/oauth/token
api_url = https://{DOMAIN}/api/oauth/userinfo
role_attribute_path = contains(groups[*], 'Admin') && 'Admin' || contains(groups[*], 'DevOps') && 'Admin' || contains(groups[*], 'Tech Lead') && 'Editor' || 'Viewer'
```

### Authorization Code Flow

```
                          ┌─────────────┐
                          │   Platform   │
                          │   OAuth2     │
                          │   Provider   │
                          └──────┬──────┘
                                 │
  ┌──────────┐    1. Auth Req    │
  │  Client   │──────────────────→│
  │ (Service) │                  │
  │           │←──────────────────│
  │           │  2. Auth Code     │
  │           │                  │
  │           │──────────────────→│
  │           │  3. Token Req     │
  │           │   (code + secret) │
  │           │←──────────────────│
  │           │  4. Access+ID Tok │
  └──────────┘
```

1. **Authorize** — `GET /api/oauth/authorize?client_id=...&redirect_uri=...&response_type=code`
2. **Code grant** — User authenticates via Portal, receives temporary authorization code (5-min TTL)
3. **Token exchange** — `POST /api/oauth/token` with `code`, `client_id`, `redirect_uri`, `grant_type=authorization_code`
4. **Tokens returned** — Access Token (RS256, 1h), ID Token (RS256, with `sub`, `email`, `groups`, `roles`)

### JWKS Endpoint

```http
GET /api/oauth/jwks
```

Returns the RSA public key in JWK format for token verification by relying parties.

### OpenID Configuration

```http
GET /api/oauth/.well-known/openid-configuration
```

Returns standard OIDC discovery document.

---

## Permission Cache Invalidation

Permissions are cached in-memory with a **60-second TTL** to reduce database load.

```typescript
// platform/api/src/middleware/auth.ts:10
const PERMISSION_CACHE_TTL_MS = 60_000;
```

### Cache Clearing Triggers

| Action | Cache Effect | Code Location |
|---|---|---|
| `PATCH /users/:id/role` | Clears cache for that user | `auth.ts:322` — `clearPermissionCache(id)` |
| `PUT /roles/:id` | Clears cache for all users with that custom role | `auth.ts:435-436` |
| `DELETE /roles/:id` | Clears cache for all affected users | `auth.ts:470` |
| API restart | Entire cache cleared | In-memory map is recreated |

### Manual Cache Clear

```typescript
import { clearPermissionCache } from '../middleware/auth';
clearPermissionCache();          // Clear ALL caches
clearPermissionCache(userId);    // Clear single user's cache
```

> The permission cache is process-local. In multi-replica deployments, cache invalidation is per-instance. A future enhancement should use Redis for distributed caching.
