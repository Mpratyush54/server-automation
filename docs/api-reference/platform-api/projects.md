# Projects API

Manage platform projects, environments, and SDK tokens.

---

## `GET` /api/projects

Lists all projects with their related environments and deployments.

**Auth:** Bearer token (any authenticated user)

**Response `200`:**
```json
[
  {
    "id": "uuid",
    "name": "my-app",
    "stack": "nodejs",
    "description": "My application",
    "repositoryUrl": "https://gitlab.com/org/my-app",
    "domain": "my-app.example.com",
    "clickupListId": null,
    "isActive": true,
    "environments": [
      {
        "id": "uuid",
        "name": "development",
        "namespace": "my-app-development",
        "domain": "my-app-development.example.com"
      }
    ],
    "deployments": []
  }
]
```

---

## `POST` /api/projects

Creates a new project. Automatically creates development, staging, and production environments. Requires DEVOPS or TECH_LEAD role. Audit-logged.

**Auth:** Bearer token (DEVOPS, TECH_LEAD)

**Request Body:**
```json
{
  "name": "my-app",
  "stack": "nodejs",
  "description": "My application",
  "repositoryUrl": "https://gitlab.com/org/my-app",
  "domain": "my-app.example.com",
  "clickupListId": "optional-clickup-list-id"
}
```

**Stack Types:** `nodejs`, `angular`, `python`, `static`

**Response `201`:**
```json
{
  "id": "uuid",
  "name": "my-app",
  "stack": "nodejs",
  "description": "My application",
  "repositoryUrl": "https://gitlab.com/org/my-app",
  "domain": "my-app.example.com",
  "isActive": true
}
```

---

## `GET` /api/projects/:id

Retrieves a single project by ID with its environments and deployments.

**Auth:** Bearer token (any authenticated user)

**Response `200`:**
```json
{
  "id": "uuid",
  "name": "my-app",
  "stack": "nodejs",
  "description": "My application",
  "repositoryUrl": "https://gitlab.com/org/my-app",
  "domain": "my-app.example.com",
  "isActive": true,
  "environments": [],
  "deployments": []
}
```

**Error `404`:**
```json
{ "error": "Project not found" }
```

---

## `PUT` /api/projects/:id

Updates a project's settings. Requires DEVOPS or TECH_LEAD role. Audit-logged.

**Auth:** Bearer token (DEVOPS, TECH_LEAD)

**Request Body:** (all fields optional)
```json
{
  "name": "updated-app",
  "stack": "python",
  "description": "Updated description",
  "repositoryUrl": "https://gitlab.com/org/updated-app",
  "domain": "updated-app.example.com",
  "clickupListId": "new-list-id"
}
```

**Response `200`:**
```json
{
  "id": "uuid",
  "name": "updated-app",
  "stack": "python",
  "description": "Updated description"
}
```

---

## `DELETE` /api/projects/:id

Deletes a project and everything it created, then frees its name for a new project. It runs in the background; the call returns at once.

**Auth:** Bearer token (DEVOPS role and project owner access), with a recent two-factor confirmation. Without one the API answers `401 { "error": "step_up_required" }`: confirm with `POST /api/auth/mfa/step-up`, then retry. Agent tokens cannot delete projects.

**Request:**
```json
{ "confirmName": "my-app", "deleteDatabases": false }
```

| Field | Required | Meaning |
|-------|----------|---------|
| `confirmName` | Yes | The exact project name. Anything else returns `400` with code `confirm_name_mismatch`. |
| `deleteDatabases` | No (default `false`) | `true` drops the project's databases after they are backed up. `false` keeps them, with logins turned off, and writes where they are to the audit log. |

**What happens, in order:**

1. The project is hidden, and new deploys, builds and SDK calls are refused.
2. Connections to the project's databases are paused, and every database (PostgreSQL, MongoDB, Redis) is backed up to the configured backup target. The backups are listed under the project's database backups. **If any backup fails, nothing is deleted**: the project comes back as it was and the error says which backup failed and why.
3. The Argo CD applications (with the apps they created), previews, running builds and built images are removed.
4. The project's namespaces are removed, with everything in them: workloads, web addresses, certificates, secrets and ConfigMaps.
5. Synthetic checks, alert rules and the status page are removed.
6. SDK tokens are revoked, and secrets and variables are deleted.
7. The databases are dropped (`deleteDatabases: true`) or kept, locked.
8. Logs, errors, replays, heatmaps, usage data and uploaded files are deleted.
9. The project is marked deleted. Its row, deployment history and the audit log stay.

Each step that removes something writes an audit log entry (`project.delete.*`, then `project.deleted`).

A namespace or Argo CD application is only removed when it carries this project's id; anything else is reported and left alone.

**Response `202`:**
```json
{ "operationId": "uuid", "status": "running", "resumed": false, "alreadyRunning": false }
```

**If a step fails** after removal has started, the project stays hidden and keeps its name. Call `DELETE` again to retry: it continues from where it stopped and does not repeat the backups. Calling it while a delete is running returns that delete.

**Other responses:** `404` project not found, `409` with code `project_already_deleted`.

### `GET` /api/projects/:id/deletion

Progress of the project's deletion. **Auth:** project viewer.

```json
{
  "status": "running",
  "deleteDatabases": false,
  "operation": { "id": "uuid", "status": "running", "steps": [{ "name": "back-up-databases", "status": "succeeded" }] }
}
```

`status` is `none`, `running`, `failed` (call `DELETE` again), `aborted` (stopped before anything was deleted) or `deleted`.

### Reusing a name

A deleted project frees its name. A new project with that name gets its own namespaces, Argo CD applications, preview addresses and databases, all named from its own id, so it never takes over anything the old project left. While a delete is still running or has failed, the name stays taken (`409` with code `project_name_deleting`).

---

## SDK Tokens

### `GET` /api/projects/:projectId/tokens

Lists all SDK tokens for a project. Token values are masked for security.

**Auth:** Bearer token (any authenticated user)

**Response `200`:**
```json
[
  {
    "id": "uuid",
    "name": "production-token",
    "token": "sdk_live_abc123...defg",
    "status": "active",
    "createdAt": "2026-01-01T00:00:00.000Z"
  }
]
```

### `POST` /api/projects/:projectId/tokens

Creates a new SDK token. The plaintext token is returned only once. Requires DEVOPS or TECH_LEAD role. Audit-logged.

**Auth:** Bearer token (DEVOPS, TECH_LEAD)

**Request Body:**
```json
{
  "name": "production-token"
}
```

**Response `201`:**
```json
{
  "id": "uuid",
  "name": "production-token",
  "token": "sdk_live_abc123def456...",
  "status": "active",
  "createdAt": "2026-01-01T00:00:00.000Z"
}
```

### `DELETE` /api/projects/:projectId/tokens/:tokenId

Revokes an SDK token by deleting it. Requires DEVOPS or TECH_LEAD role (the same roles that can create tokens) and project devops access. Audit-logged.

**Auth:** Bearer token (DEVOPS, TECH_LEAD)

**Error `404`:** `SDK Token not found` (unknown id, or a token of another project).

**Response `200`:**
```json
{ "success": true, "message": "SDK Token revoked" }
```

---

## ArgoCD Status

### `GET` /api/projects/:projectId/argocd-status

Queries the ArgoCD application status for the project's staging environment.

**Auth:** Bearer token (any authenticated user)

**Response `200` (connected):**
```json
{
  "connected": true,
  "appName": "my-app-staging",
  "syncStatus": "Synced",
  "healthStatus": "Healthy",
  "revision": "abc123def456",
  "syncTime": "2026-07-01T12:00:00.000Z"
}
```

**Response `200` (disconnected):**
```json
{
  "connected": false,
  "error": "Could not reach ArgoCD: ...",
  "syncStatus": "Offline",
  "healthStatus": "Unknown"
}
```

---

## Live Resource Topology

### `GET` /api/projects/:projectId/environments/:envId/topology

Read-only resource graph of one environment, shown on the portal's GitOps tab
(refreshed every 10 s while the tab is visible). `envId` is the environment UUID
(an environment name such as `staging` is accepted too).

Combines the ArgoCD Application's `status.resources` (sync / health per managed
resource, including `Missing` ones) with live objects listed in the environment
namespace only: Deployments, ReplicaSets, Pods, Services, Ingresses, cert-manager
Certificates, PVCs and Events. Secret and ConfigMap nodes are derived from the
objects that reference them (names only); the API never lists or reads Secrets.

**Auth:** Bearer token, project member (viewer or higher), or agent token with `projects:read`

**Response `200`:**
```json
{
  "namespace": "shop-staging-0123456789abcdef",
  "appName": "shop-staging-0123456789abcdef",
  "environmentId": "…",
  "environment": "staging",
  "argo": { "found": true, "error": null, "sync": "Synced", "health": "Healthy", "revision": "abc123" },
  "nodes": [
    { "id": "Deployment/web", "kind": "Deployment", "name": "web", "health": "Healthy", "sync": "Synced",
      "info": { "replicas": 3, "readyReplicas": 3 }, "events": [] },
    { "id": "Pod/web-7d9-a", "kind": "Pod", "name": "web-7d9-a", "health": "Degraded", "sync": null,
      "info": { "ready": "0/1", "reason": "CrashLoopBackOff", "restarts": 7 }, "events": [] }
  ],
  "edges": [
    { "from": "Deployment/web", "to": "ReplicaSet/web-7d9", "type": "owns" },
    { "from": "Ingress/web", "to": "Service/web", "type": "routes" },
    { "from": "Service/web", "to": "Pod/web-7d9-a", "type": "selects" }
  ],
  "counts": { "Deployment": 1, "ReplicaSet": 1, "Pod": 1 },
  "warnings": [],
  "generatedAt": "2026-11-10T12:00:00.000Z"
}
```

Edges: `owns` (ownerReferences, and Application → managed resource), `routes`
(Ingress backend → Service), `selects` (Service selector → Pod, Ingress TLS /
Certificate `secretName`, Pod → PVC / ConfigMap / Secret it uses). `argo.found` is
`false` when the Application does not exist; the live graph is still returned.
`warnings` names reads that failed (for example missing RBAC in an older namespace).
`503` when Kubernetes is unreachable.

---

## Error Codes

| Status | Error                           | Description                         |
|--------|---------------------------------|-------------------------------------|
| 404    | `Project not found`             | Project ID does not exist           |
| 404    | `SDK Token not found`           | Token ID does not exist             |
| 400    | `Token name is required`        | Missing name when creating token    |

---

## Related

- [Deployments API](deployments.md)
- [Secrets API](secrets.md)
- [Databases API](databases.md)
