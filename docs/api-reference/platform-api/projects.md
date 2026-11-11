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

Soft-deletes a project by setting `deletedAt` and `isActive = false`. Requires DEVOPS role. Audit-logged.

**Auth:** Bearer token (DEVOPS)

**Response `200`:**
```json
{ "message": "Project soft-deleted" }
```

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
