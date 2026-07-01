# Auth API

Authentication and user management endpoints.

---

## `GET` /api/health

Health check endpoint. Returns a simple status to confirm the API is running.

**Auth:** None

**Response `200`:**
```json
{
  "status": "ok"
}
```

---

## `POST` /api/auth/login

Authenticates a user via email. No password is required — the platform uses email-only authentication. Returns a JWT token and the user object.

**Auth:** None

**Request Body:**
```json
{
  "email": "admin@dev.io"
}
```

**Response `200`:**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "user": {
    "id": "00000000-0000-0000-0000-000000000001",
    "email": "admin@dev.io",
    "name": "Admin",
    "role": "admin",
    "lastLogin": "2026-07-01T12:00:00.000Z"
  }
}
```

**Error `401`:**
```json
{
  "error": "User email not found. Run init-demo first."
}
```

---

## `GET` /api/auth/gitlab

Initiates GitLab OAuth flow. Redirects to the callback endpoint with a mock authorization code.

**Auth:** None

**Response `302`:** Redirect to `/api/auth/gitlab/callback?code=mock_gitlab_code`

---

## `GET` /api/auth/gitlab/callback

GitLab OAuth callback. Creates or updates a user from the GitLab profile, generates a JWT, and redirects to the portal dashboard with the token.

**Auth:** None

**Query Parameters:**
| Param | Type   | Description              |
|-------|--------|--------------------------|
| code  | string | Authorization code (mock)|

**Response `302`:** Redirect to `{PORTAL_URL}/dashboard?token={jwt}`

---

## `GET` /api/users/init-demo

Seeds the database with four demo users if they do not already exist:

| Name         | Email             | Role       |
|--------------|-------------------|------------|
| Admin        | admin@dev.io      | admin      |
| John Dev     | john@dev.io       | developer  |
| Sarah Lead   | sarah@dev.io      | tech_lead  |
| DevOps Boss  | devops@dev.io     | devops     |

**Auth:** None

**Response `200`:**
```json
{
  "message": "Created 4 new demo users",
  "users": [
    { "id": "00000000-0000-0000-0000-000000000001", "name": "Admin", "email": "admin@dev.io", "role": "admin" }
  ]
}
```

---

## `GET` /api/users/me

Returns the currently authenticated user's profile, including the linked custom role (`roleRef`) if assigned.

**Auth:** Bearer token (any authenticated user)

**Response `200`:**
```json
{
  "id": "00000000-0000-0000-0000-000000000001",
  "email": "admin@dev.io",
  "name": "Admin",
  "role": "admin",
  "roleId": null,
  "roleRef": null,
  "gitlabId": null,
  "avatarUrl": null,
  "lastLogin": "2026-07-01T12:00:00.000Z",
  "isActive": true,
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-07-01T12:00:00.000Z"
}
```

---

## `PATCH` /api/users/me

Updates the current user's profile. Only `name` and `avatarUrl` can be modified.

**Auth:** Bearer token (any authenticated user)

**Request Body:**
```json
{
  "name": "New Name",
  "avatarUrl": "https://example.com/avatar.png"
}
```

**Response `200`:**
```json
{
  "id": "...",
  "name": "New Name",
  "email": "admin@dev.io",
  "role": "admin",
  "avatarUrl": "https://example.com/avatar.png"
}
```

---

## `GET` /api/users

Lists all users. Requires DEVOPS or TECH_LEAD role.

**Auth:** Bearer token (DEVOPS, TECH_LEAD)

**Response `200`:**
```json
[
  {
    "id": "00000000-0000-0000-0000-000000000001",
    "email": "admin@dev.io",
    "name": "Admin",
    "role": "admin"
  }
]
```

---

## `POST` /api/users

Creates a new user. Requires DEVOPS role. Audit-logged.

**Auth:** Bearer token (DEVOPS)

**Request Body:**
```json
{
  "name": "New User",
  "email": "newuser@dev.io",
  "role": "developer",
  "gitlabId": null,
  "avatarUrl": null
}
```

**Response `201`:**
```json
{
  "id": "88888888-8888-8888-8888-888888888888",
  "name": "New User",
  "email": "newuser@dev.io",
  "role": "developer",
  "gitlabId": null,
  "avatarUrl": null
}
```

---

## `PUT` /api/users/:id

Updates an existing user's details. Requires DEVOPS role. Audit-logged.

**Auth:** Bearer token (DEVOPS)

**Request Body:** (all fields optional)
```json
{
  "name": "Updated Name",
  "email": "updated@dev.io",
  "role": "tech_lead",
  "gitlabId": "gitlab-123",
  "avatarUrl": "https://example.com/avatar.png"
}
```

**Response `200`:**
```json
{
  "id": "...",
  "name": "Updated Name",
  "email": "updated@dev.io",
  "role": "tech_lead"
}
```

**Error `404`:**
```json
{ "error": "User not found" }
```

---

## `PATCH` /api/users/:id/role

Changes a user's role assignment. Supports setting both the built-in role enum and a custom role ID. Requires `users.assign-role` permission. Clears permission cache for that user.

**Auth:** Bearer token (`users.assign-role` permission)

**Request Body:**
```json
{
  "role": "tech_lead",
  "roleId": "uuid-of-custom-role"
}
```

**Response `200`:**
```json
{
  "id": "...",
  "role": "tech_lead",
  "roleId": "uuid-of-custom-role"
}
```

---

## `DELETE` /api/users/:id

Hard-deletes a user from the database. Requires DEVOPS role. Audit-logged.

**Auth:** Bearer token (DEVOPS)

**Response `200`:**
```json
{ "success": true }
```

---

## `POST` /api/users/invite

Invites a new user by email. Requires `users.create` permission. Returns `409` if the email already exists. Audit-logged.

**Auth:** Bearer token (`users.create` permission)

**Request Body:**
```json
{
  "email": "invited@dev.io",
  "name": "Invited User",
  "role": "developer",
  "roleId": null
}
```

**Response `201`:**
```json
{
  "id": "...",
  "name": "Invited User",
  "email": "invited@dev.io",
  "role": "developer"
}
```

**Error `409`:**
```json
{ "error": "User with this email already exists" }
```

---

## `GET` /api/users/:id/permissions

Returns the computed set of permissions for a given user. Merges role preset permissions with custom role permissions. Uses an in-memory cache (TTL: 60s).

**Auth:** Bearer token (any authenticated user)

**Response `200`:**
```json
{
  "userId": "uuid",
  "role": "devops",
  "roleId": null,
  "permissions": [
    "users.list",
    "users.create",
    "projects.list",
    "deployments.trigger",
    "..."
  ]
}
```

---

## Roles CRUD

### `GET` /api/roles

Lists all custom roles. Requires `users.list` permission.

**Response `200`:**
```json
[
  {
    "id": "uuid",
    "name": "custom-role",
    "description": "My custom role",
    "permissions": ["projects.list", "deployments.read"],
    "isSystem": false,
    "isActive": true
  }
]
```

### `GET` /api/roles/:id

Gets a single role by ID. Requires `users.list` permission.

### `POST` /api/roles

Creates a new custom role. Requires `users.create` permission. Returns `409` if name already exists. Audit-logged.

**Request Body:**
```json
{
  "name": "custom-role",
  "description": "Optional description",
  "permissions": ["projects.list", "deployments.read"]
}
```

### `PUT` /api/roles/:id

Updates a custom role. System roles cannot be modified. Clears permission cache for all users with this role. Requires `users.update` permission. Audit-logged.

**Request Body:**
```json
{
  "name": "updated-role",
  "description": "Updated description",
  "permissions": ["projects.list", "projects.create"],
  "isActive": true
}
```

### `DELETE` /api/roles/:id

Deletes a custom role. System roles cannot be deleted. Unassigns the role from all users. Requires `users.delete` permission. Audit-logged.

**Response `200`:**
```json
{ "success": true }
```

---

## Permission Validation

### `GET` /api/permissions

Returns the full list of all available permissions in the system. Requires `users.list` permission.

**Response `200`:**
```json
{
  "users.list": "List all users",
  "users.create": "Create new users",
  "projects.list": "List all projects",
  "...": "..."
}
```

### `POST` /api/roles/:id/permissions/validate

Validates an array of permission strings against the known permission set. Returns lists of valid and invalid entries. Requires `users.update` permission.

**Request Body:**
```json
{
  "permissions": ["projects.list", "invalid.perm", "deployments.read"]
}
```

**Response `200`:**
```json
{
  "valid": ["projects.list", "deployments.read"],
  "invalid": ["invalid.perm"],
  "totalValid": 2,
  "totalInvalid": 1
}
```

---

## Error Codes

| Status | Code                         | Description                         |
|--------|------------------------------|-------------------------------------|
| 401    | `Unauthorized: Missing token`| No Bearer token provided            |
| 401    | `User email not found...`    | Login email not recognized          |
| 404    | `User not found`             | User ID does not exist              |
| 409    | `User with this email...`    | Duplicate email on invite           |
| 409    | `Role with this name...`     | Duplicate role name                 |
| 400    | `Cannot modify system roles` | Attempted to edit a system role     |
| 400    | `Cannot delete system roles` | Attempted to delete a system role   |
| 400    | `Email and name are required`| Missing required fields on invite   |

---

## Related

- [Permissions Configuration](/docs/api-reference/configuration/permissions)
- [Deployments API](deployments.md)
- [Projects API](projects.md)
