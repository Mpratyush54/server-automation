# Webhooks API

Handle incoming webhooks from GitHub and GitLab, and auto-register webhooks for CI/CD integration.

---

## `POST` /api/webhooks/github

Receives GitHub webhook events. Supports `push` and `pull_request` events. Signature verification is performed using `x-hub-signature-256`.

**Events handled:**
- **Push to `main`/`master`:** Triggers a staging deployment via GitLab pipeline.
- **Push to other branches:** Creates a preview environment with K8s deployment and posts a ClickUp comment if the branch name contains a task ID.
- **PR opened/synchronized:** Deploys a preview environment.
- **PR closed (unmerged):** Terminates the preview environment.

**Auth:** Bearer token (authenticated)

**Headers:**
```
x-hub-signature-256: sha256=...
x-github-event: push
```

**Example GitHub push payload (simplified):**
```json
{
  "ref": "refs/heads/main",
  "after": "abc123",
  "repository": {
    "clone_url": "https://github.com/org/my-app.git"
  }
}
```

**Response `200`:**
```json
{
  "success": true,
  "message": "Staging deploy triggered"
}
```

---

## `POST` /api/webhooks/gitlab

Receives GitLab webhook events. Supports `Push Hook` and `Merge Request Hook` events. Token verification is performed using `x-gitlab-token`.

**Events handled:**
- **Push to `main`/`master`:** Triggers a staging deployment.
- **Push to other branches:** Deploys a preview environment and posts a ClickUp comment.
- **MR opened/updated:** Deploys a preview environment.
- **MR closed/merged:** Terminates or marks the preview deployment.

**Auth:** Bearer token (authenticated)

**Headers:**
```
x-gitlab-token: shared-secret
x-gitlab-event: Push Hook
```

**Example GitLab push payload (simplified):**
```json
{
  "ref": "refs/heads/main",
  "after": "abc123",
  "project": {
    "http_url": "https://gitlab.com/org/my-app.git"
  }
}
```

**Response `200`:**
```json
{
  "success": true,
  "message": "Staging deploy triggered"
}
```

---

## `POST` /api/cicd/register-webhook/:projectId

Auto-registers a webhook on GitHub or GitLab for a project. Detects the provider from the project's `repositoryUrl`. Requires DEVOPS or TECH_LEAD role.

**Auth:** Bearer token (DEVOPS, TECH_LEAD)

**GitLab Registration:** Creates a webhook with `push_events` and `merge_requests_events` enabled. Requires `GITLAB_TOKEN` environment variable.

**GitHub Registration:** Creates a webhook for `push` and `pull_request` events. Requires `GITHUB_TOKEN` and `GITHUB_WEBHOOK_SECRET` environment variables.

**Response `200` (GitLab):**
```json
{
  "success": true,
  "message": "Webhook registered on GitLab",
  "webhookUrl": "https://api.example.com/api/webhooks/gitlab"
}
```

**Response `200` (GitHub):**
```json
{
  "success": true,
  "message": "Webhook registered on GitHub",
  "webhookUrl": "https://api.example.com/api/webhooks/github"
}
```

**Error `400`:**
```json
{ "error": "No repository URL configured for this project" }
```

**Error `500`:**
```json
{ "error": "GitLab webhook registration failed: ..." }
```

---

## Error Codes

| Status | Error                       | Description                          |
|--------|-----------------------------|--------------------------------------|
| 401    | `Invalid signature`         | GitHub signature verification failed |
| 401    | `Invalid token`             | GitLab token verification failed     |
| 400    | `No repository URL...`      | Project has no repositoryUrl set     |
| 400    | `Unsupported repository...` | Only GitHub and GitLab are supported |
| 500    | `GITLAB_TOKEN not configured` | Missing env var for registration   |
| 500    | `GITHUB_TOKEN and...`       | Missing env vars for registration   |

---

## Related

- [Deployments API](deployments.md)
- [Projects API](projects.md)
- [CI/CD Setup Guide](/docs/deployment/ci-cd-setup)
