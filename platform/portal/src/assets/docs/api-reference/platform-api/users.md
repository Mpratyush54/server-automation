# Users & Roles API

Endpoints for managing users, their preset role, custom role assignment, and the
role/permission catalogue itself.

Auth model in short: every user has one **preset role** (`admin`, `devops`,
`tech_lead`, `developer`, `viewer`) plus an optional **custom role** referenced
by `roleId`. Effective permissions are the union of the two, cached per-user for
60 s.

---

## Preset roles

| Role | Typical usage |
|---|---|
| `admin` | Full access. Can manage users, roles and every resource. |
| `devops` | Cluster + infra ops. Users CRUD, deployments, secrets, backups. |
| `tech_lead` | Project owner. Manages own projects, secrets and deployments. |
| `developer` | Standard app dev. Reads projects, triggers deploys. |
| `viewer` | Read-only. Dashboards, deployments, audit logs. |

Every preset role is seeded on API boot; you cannot delete them. Custom roles
sit alongside and can layer additional permissions.

---

## User endpoints

### `GET` /api/users

List every user.

**Auth:** `devops` or `tech_lead`

**Response `200`:**
```json
[
  {
    "id": "00000000-0000-0000-0000-000000000001",
    "name": "Admin",
    "email": "admin@dev.io",
    "role": "admin",
    "roleId": null,
    "gitlabId": null,
    "avatarUrl": null,
    "lastLogin": "2026-07-01T12:00:00.000Z",
    "isActive": true
  }
]
```

---

### `GET` /api/users/me

The currently-authenticated user, including their custom role reference.

**Auth:** any authenticated user

**Response `200`:**
```json
{
  "id": "00000000-0000-0000-0000-000000000001",
  "name": "Admin",
  "email": "admin@dev.io",
  "role": "admin",
  "roleId": null,
  "roleRef": null,
  "lastLogin": "2026-07-01T12:00:00.000Z"
}
```

---

### `PATCH` /api/users/me

Update your own display name or avatar. Cannot change your own role.

**Auth:** any authenticated user

**Request Body:**
```json
{
  "name": "New Display Name",
  "avatarUrl": "https://cdn.example.com/me.png"
}
```

**Response `200`:** Updated user object.

---

### `POST` /api/users

Create a user directly (no email invite). Prefer `POST /api/users/invite` for
onboarding flows.

**Auth:** `devops`

**Request Body:**
```json
{
  "name": "Alice",
  "email": "alice@example.com",
  "role": "developer",
  "gitlabId": null,
  "avatarUrl": null
}
```

**Response `201`:** Created user object.

**Error `400`:** Missing / invalid fields.

---

### `POST` /api/users/invite

Invite a user by email. Idempotent-ish — returns `409` if the email already
exists.

**Auth:** requires `users.create` permission

**Request Body:**
```json
{
  "email": "alice@example.com",
  "name": "Alice",
  "role": "developer",
  "roleId": "b3d5..."
}
```

`role` defaults to `developer` if omitted. `roleId` is optional (points at a
custom role).

**Response `201`:** Created user object.

**Error `400`:** `Email and name are required`.

**Error `409`:** `User with this email already exists`.

---

### `PUT` /api/users/:id

Full update of a user record.

**Auth:** `devops`

**Request Body:** any of `name`, `email`, `role`, `gitlabId`, `avatarUrl`.

**Response `200`:** Updated user.

**Error `404`:** `User not found`.

---

### `PATCH` /api/users/:id/role

Change a user's preset role and/or custom role. Clears their permission cache
immediately so the change takes effect on the next request.

**Auth:** requires `users.assign-role` permission

**Request Body:**
```json
{
  "role": "tech_lead",
  "roleId": null
}
```

**Response `200`:** Updated user object.

---

### `DELETE` /api/users/:id

**Auth:** `devops`

**Response `200`:**
```json
{ "success": true }
```

**Error `404`:** `User not found`.

---

### `GET` /api/users/:id/permissions

Resolve a user's *effective* permissions (preset ∪ custom). Useful for
UI-level "can I do X" checks.

**Auth:** any authenticated user

**Response `200`:**
```json
{
  "userId": "…",
  "role": "developer",
  "roleId": null,
  "permissions": ["projects.list", "projects.read", "deployments.trigger"]
}
```

---

### `GET` /api/users/init-demo

Bootstrap the demo users (`admin@dev.io`, `devops@dev.io`, `sarah@dev.io`,
`john@dev.io`). Runs automatically on first API boot; call it manually if the
`users` table is empty for any reason.

**Auth:** None

**Response `200`:**
```json
{ "created": 4, "users": [ … ] }
```

---

## Role endpoints

### `GET` /api/roles

List custom roles.

**Auth:** requires `users.list` permission

**Response `200`:**
```json
[
  {
    "id": "…",
    "name": "release-manager",
    "description": "Can approve production deployments",
    "permissions": ["deployments.approve"],
    "isSystem": false,
    "isActive": true
  }
]
```

---

### `GET` /api/roles/:id

Get one custom role.

**Auth:** requires `users.list` permission

**Response `200`:** The role object.

**Error `404`:** `Role not found`.

---

### `POST` /api/roles

Create a custom role.

**Auth:** requires `users.create` permission

**Request Body:**
```json
{
  "name": "release-manager",
  "description": "Approves prod deploys",
  "permissions": ["deployments.approve", "deployments.read"]
}
```

Permission strings are validated against the catalogue served by
`GET /api/permissions`. Any unknown string is rejected with `400`.

**Response `201`:** Created role.

---

### `PUT` /api/roles/:id

Update a custom role.

**Auth:** requires `users.update` permission

**Request Body:** any of `name`, `description`, `permissions`, `isActive`.

**Response `200`:** Updated role.

**Error `403`:** `Cannot modify system role` — set on `isSystem: true` presets.

---

### `DELETE` /api/roles/:id

**Auth:** requires `users.delete` permission

**Response `200`:**
```json
{ "success": true }
```

**Error `403`:** `Cannot delete system role`.

---

### `POST` /api/roles/:id/permissions/validate

Dry-run a permission set against the catalogue. Useful before saving.

**Auth:** requires `users.update` permission

**Request Body:**
```json
{
  "permissions": ["deployments.approve", "not.a.real.permission"]
}
```

**Response `200`:**
```json
{
  "valid": false,
  "unknown": ["not.a.real.permission"]
}
```

---

## Permission catalogue

### `GET` /api/permissions

The full list of permission strings recognised by the platform, grouped by
resource. Use this to power a permission-picker UI.

**Auth:** requires `users.list` permission

**Response `200`:**
```json
{
  "users":       ["users.list", "users.create", "users.update", "users.delete", "users.assign-role"],
  "projects":    ["projects.list", "projects.read", "projects.create", "projects.update", "projects.delete"],
  "deployments": ["deployments.trigger", "deployments.approve", "deployments.read"],
  "secrets":     ["secrets.read", "secrets.write", "secrets.rotate"],
  "audit":       ["audit.read"]
}
```

The list is source-of-truth for role validation — no permission accepted by
`POST /api/roles` is ever outside this set.

---

## Related

- [Auth API](auth.md)
- [Audit Logs API](audit-logs.md)
- [Auth Flow Architecture](/docs/architecture/auth-flow)
- [Permissions Configuration](/docs/api-reference/configuration/permissions)
