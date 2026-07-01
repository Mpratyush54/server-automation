# Deployments API

Deploy, rollback, terminate, restart, and scale application deployments.

**Deployment Statuses:** `pending`, `building`, `deploying`, `deployed`, `failed`, `rolled_back`, `terminated`, `expired`

---

## `GET` /api/deployments/:projectId

Lists all deployments for a project, ordered by creation date descending.

**Auth:** Bearer token (any authenticated user)

**Response `200`:**
```json
[
  {
    "id": "uuid",
    "projectId": "uuid",
    "environmentId": "uuid",
    "version": "1.0.0",
    "branch": "main",
    "commitSha": "abc123",
    "imageTag": "my-app:latest",
    "status": "deployed",
    "deployedById": "uuid",
    "previewUrl": null,
    "deployedAt": "2026-07-01T12:00:00.000Z",
    "createdAt": "2026-07-01T12:00:00.000Z"
  }
]
```

---

## `POST` /api/deploy

Triggers a new deployment. Creates a deployment record and runs the deploy process asynchronously:

- **Preview environments** are created on-the-fly and deployed via K8s manifests.
- **Staging/Production** environments are deployed via ArgoCD with status polling (up to 3 minutes).
- On success, an SMTP notification is sent to all DEVOPS users (if SMTP is configured).
- If the branch contains a ClickUp task ID, a preview comment is posted and the task is linked.

**Auth:** Bearer token (DEVOPS, TECH_LEAD, DEVELOPER)

**Request Body:**
```json
{
  "projectId": "uuid",
  "environmentId": "uuid",
  "environmentName": "staging",
  "version": "2.0.0",
  "branch": "feature/new-feature",
  "commitSha": "def456",
  "imageTag": "my-app:2.0.0",
  "metadata": {}
}
```

| Field           | Type   | Required | Description                              |
|-----------------|--------|----------|------------------------------------------|
| projectId       | uuid   | yes      | Project to deploy                        |
| environmentId   | uuid   | no       | Target environment (omit for preview)    |
| environmentName | string | no       | Use `preview` to create a preview env    |
| version         | string | no       | Semantic version (default: `1.0.0`)      |
| branch          | string | no       | Git branch (default: `main`)             |
| commitSha       | string | no       | Git commit SHA (default: `unknown`)      |
| imageTag        | string | no       | Docker image tag (default: `latest`)     |
| metadata        | object | no       | Arbitrary metadata                       |

**Response `201`:**
```json
{
  "id": "uuid",
  "projectId": "uuid",
  "environmentId": "uuid",
  "version": "2.0.0",
  "branch": "feature/new-feature",
  "status": "pending",
  "previewUrl": null,
  "createdAt": "2026-07-01T12:00:00.000Z"
}
```

---

## `POST` /api/deployments/:id/terminate

Terminates a deployment by setting its status to `terminated`. Requires DEVOPS, TECH_LEAD, or DEVELOPER role. Audit-logged.

**Auth:** Bearer token (DEVOPS, TECH_LEAD, DEVELOPER)

**Response `200`:**
```json
{
  "id": "uuid",
  "status": "terminated",
  "terminatedAt": "2026-07-01T12:00:00.000Z"
}
```

---

## `POST` /api/deployments/:id/restart

Restarts a deployment by resetting its status to `pending`. Simulates a fresh deploy after 2 seconds. Requires DEVOPS role.

**Auth:** Bearer token (DEVOPS)

**Response `200`:**
```json
{
  "message": "Restart triggered",
  "deployment": {
    "id": "uuid",
    "status": "pending"
  }
}
```

---

## `PATCH` /api/deployments/:id/scale

Scales a deployment by updating its replica count in metadata. Requires DEVOPS role. Audit-logged.

**Auth:** Bearer token (DEVOPS)

**Request Body:**
```json
{
  "replicas": 5
}
```

**Response `200`:**
```json
{
  "id": "uuid",
  "metadata": {
    "replicas": 5
  }
}
```

---

## `POST` /api/rollback

Rolls back a deployment to a previous version. Marks the current deployment as `rolled_back` and creates a new deployment record with the previous version. Triggers a GitLab pipeline. Requires DEVOPS or TECH_LEAD role. Audit-logged.

**Auth:** Bearer token (DEVOPS, TECH_LEAD)

**Request Body:**
```json
{
  "deploymentId": "uuid-of-deployment-to-rollback",
  "previousVersion": "1.0.0"
}
```

**Response `201`:**
```json
{
  "rolledBack": {
    "id": "uuid",
    "status": "rolled_back",
    "terminatedAt": "2026-07-01T12:00:00.000Z"
  },
  "newDeployment": {
    "id": "uuid",
    "version": "1.0.0",
    "status": "deployed",
    "deployedAt": "2026-07-01T12:00:00.000Z"
  }
}
```

---

## Error Codes

| Status | Error                        | Description                          |
|--------|------------------------------|--------------------------------------|
| 404    | `Project not found`          | Invalid projectId                    |
| 404    | `Environment not found`      | Invalid environmentId                |
| 404    | `Deployment not found`       | Invalid deployment ID                |

---

## Related

- [Projects API](projects.md)
- [Webhooks API](webhooks.md)
- [Databases API](databases.md)
