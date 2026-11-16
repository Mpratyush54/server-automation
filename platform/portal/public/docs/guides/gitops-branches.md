# GitOps branches and ArgoCD actions

Deployments and SDK registration choose a Git revision in this order:

1. Explicit request `gitRevision`, then `branch`.
2. The project setting `gitRevision` (the portal's Git revision override).
3. The repository default branch, cached in `Project.defaultBranch`.
4. `HEAD` when discovery is unavailable.

GitHub and configured GitLab repositories use their provider API with the existing
`GITHUB_TOKEN` / `GITLAB_TOKEN` credentials. Discovery falls back to the smart-HTTP
Git upload-pack HEAD symref; the API image does not need a Git executable.
Only origins already supported by `parseGitRemote` are contacted. Other origins
use `HEAD`, leaving resolution to ArgoCD. Requests have a five-second timeout,
reject redirects, and never forward provider tokens to another origin.

The resolved revision is saved on SDK registrations and deployment records. The
project cache is cleared when its repository URL changes. Explicit deployment
refs do not replace the cached default. Failed discovery is not cached, allowing
later registrations/deployments to recover. Set or clear the project override in
project settings; it applies on the next deployment or SDK registration. A
per-request revision takes precedence over this setting. Existing deployment
commit SHA pinning remains supported.

The GitOps tab displays the actual Application target and synced revision, sync
and health, resource counts, Argo conditions, and the latest operation's phase and
message. Conditions/messages are displayed as escaped text without rewriting.
Select an environment before requesting Refresh or Sync:

- `POST /api/projects/:projectId/argocd/refresh` adds the hard refresh annotation.
- `POST /api/projects/:projectId/argocd/sync` creates an Application operation.
- Optional JSON body: `{ "env": "production" }`; the default is development.
- Both actions require project developer access (or global admin/devops), use
  server-owned Application names, and write `argocd.refresh` / `argocd.sync` audit
  entries. Agent read tokens cannot mutate these endpoints.
- A running sync or concurrent Application change returns conflict. Accepted
  requests return 202; inspect `argocd-status` for completion or failure.

## Upgrade behavior

Migration `1790000030000` adds nullable `default_branch` and `git_revision` project
columns through the existing pre-rollout migration Job. It does not edit cluster
Applications. There are no additional services, dependencies or resource requests.

The leader's `argocd-branch-repair` job runs five seconds after leadership gain
and retries hourly. For server-assigned project Applications targeting `main`,
it requires a provider-confirmed absence of `main` and a discovered non-HEAD
default before patching the target. Explicit project overrides, multi-source apps,
other target refs and unknown/provider-error responses are skipped. Patches use
resource-version preconditions, are idempotent, update the project cache, and write
an `argocd.branch_repaired` audit entry. Existing supported sync/health response
fields are retained; `resources` is a count summary.

## VM validation still required

On a fresh Ubuntu 24.04 VM with 4 vCPU / 8 GB, provision the platform and link one
repository defaulting to `master` and one defaulting to `trunk`. Register/deploy
without a revision and confirm the Application target, stored branch and
Synced/Healthy state. Break the manifest path and confirm the exact condition and
operation error appear in the portal. Restore the path, use Refresh and Sync for
the selected environment, and verify their audit entries. Also upgrade an
Application with an invalid `main` target and confirm the leader repairs it once,
while preserving a repository that really has `main` and an explicit override.
