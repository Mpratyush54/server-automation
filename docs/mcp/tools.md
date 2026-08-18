# MCP tools and command policy

All MCP tools return JSON text. API errors include `status` and, on 401, a hint to set `PLATFORM_AGENT_TOKEN` or call `platform_login`.

This page is the human reference. Agents should follow [For AI agents](/docs/mcp/for-agents) as well.

## Session and identity

| Tool | Auth | Purpose |
|---|---|---|
| `platform_health` | none | `GET /api/health` |
| `platform_login` | none → stores JWT | Email + password; human session for approvals |
| `platform_logout` | session | Clear the in-memory human JWT (does not unset `PLATFORM_AGENT_TOKEN`) |
| `platform_whoami` | agent or human | `/api/agent-tokens/me` or `/api/users/me` |
| `platform_bootstrap_status` | as configured | Infrastructure / bootstrap status |

## Read APIs

| Tool | Typical scope | Purpose |
|---|---|---|
| `platform_list_projects` | `projects:read` | List projects |
| `platform_get_project` | `projects:read` | One project by `id` |
| `platform_search_logs` | `logs:read` | Search application logs |
| `platform_get_pod_logs` | `cluster:read` | Pod logs (`namespace`, `podName`) |
| `platform_list_pods` | `cluster:read` | List pods (optional `namespace`) |
| `platform_list_nodes` | `cluster:read` | Cluster nodes |
| `platform_audit_logs` | `audit:read` | Audit log (DevOps / Tech Lead) |

Prefer these over `platform_run_command` when they exist.

## Commands and deploys

### `platform_run_command`

Arguments: `command` (required), optional `reason`, `confirm`, `approvalId`.

1. Always calls `POST /api/agent/commands/validate` first.
2. If `confirm` is not true, returns `{ phase: "validation", validation, message }` — **stop and read it**.
3. If `confirm` is true, calls `POST /api/agent/commands/execute`.

Never skip step 2 for mutating or destructive commands.

### Human queue

| Tool | Auth | Purpose |
|---|---|---|
| `platform_list_pending_commands` | human JWT | Pending destructive commands |
| `platform_approve_command` | human JWT | Approve by `id` |
| `platform_reject_command` | human JWT | Reject by `id` (optional `reason`) |

### `platform_deploy`

`POST /api/deploy`. Required: `projectId`, `confirm: true`. Optional: `environmentId`, `version`, `branch`, `commitSha`, `imageTag`, `environmentName`, `gitPath`, `pullFromGit`, `metadata`.

Do not set `confirm` until environment, branch, and image tag are correct.

## Allowlisted commands

Only **single** commands match. Shell chaining (`&&`, `|`, `;`, backticks) is denied.

### Read-only (agent token; auto-approved)

- `kubectl get|describe|top|api-resources|api-versions|version|cluster-info`
- `kubectl logs`
- `kubectl explain`
- `helm status|list|ls|get|history|show`
- `platformctl status|version|info|health`
- `uname`, `hostname`, `uptime`, `df`, `free`, `ps`, `env`, `printenv`, `whoami`, `id`, `date`, `pwd`, `ls`, `cat`, `head`, `tail`, `wc`

### Mutating (`confirm: true` + `reason`)

- `kubectl rollout restart|status|undo|pause|resume`
- `kubectl scale`
- `kubectl apply`
- `kubectl annotate|label`
- `helm upgrade|install|rollback`

### Destructive (human approval, then `confirm` + `reason` + `approvalId`)

- `kubectl delete`
- `kubectl drain|cordon|uncordon`
- `helm uninstall|delete`
- `platformctl destroy|teardown|reset`

Anything else is `no-matching-policy` and denied.

## Denied patterns (always)

- `rm -rf /` and recursive home/root wipes
- `dd` from `/dev/`
- `mkfs`
- Disabling auth/RBAC / deleting clusterrole bindings
- Shipping secrets/passwords/tokens out via curl/wget
- Arbitrary curl/wget to hosts other than localhost, `ghcr.io`, `github.com`, `registry.*`
- `DROP DATABASE` / `DROP SCHEMA`
- Fork bombs
- Empty command
- Shell chaining / piping / substitution

## MCP resources

| URI | Content |
|---|---|
| `platform://openapi` | Live OpenAPI JSON from `GET /api/openapi.json` |
| `platform://command-policy` | Risk tiers and denied patterns (markdown) |

Read `platform://command-policy` before inventing commands.

## Default token scopes

When `POST /api/agent-tokens` omits `scopes`:

- `commands:validate`
- `commands:execute`
- `projects:read`
- `logs:read`
- `cluster:read`
- `audit:read`
- `bootstrap:read`

## Errors

| Status | Meaning |
|---|---|
| **401** | Missing/expired credentials — set `PLATFORM_AGENT_TOKEN` or `platform_login` |
| **403** | Scope, role, or policy denial |
| **409** | A pending approval already exists for that command |
| **400** | Validation failed (empty command, denied pattern, missing confirm/reason) |
