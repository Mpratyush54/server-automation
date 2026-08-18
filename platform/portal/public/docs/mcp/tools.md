# MCP tools and command policy

All tools return JSON text. Failures include `status` and a hint when the API returns 401.

## Session and identity

| Tool | Purpose |
|---|---|
| `platform_login` | Email + password → in-memory human JWT |
| `platform_logout` | Clear that JWT (does not unset `PLATFORM_AGENT_TOKEN`) |
| `platform_whoami` | `/api/agent-tokens/me` or `/api/users/me` |
| `platform_health` | `GET /api/health` (no auth) |
| `platform_bootstrap_status` | Infrastructure / bootstrap status |

## Read APIs

| Tool | Purpose |
|---|---|
| `platform_list_projects` | List projects |
| `platform_get_project` | One project by `id` |
| `platform_search_logs` | Search application logs |
| `platform_get_pod_logs` | Pod logs (`namespace`, `podName`) |
| `platform_list_pods` | List pods (optional `namespace`) |
| `platform_list_nodes` | Cluster nodes |
| `platform_audit_logs` | Audit log (DevOps / Tech Lead) |

## Commands and deploys

### `platform_run_command`

Arguments: `command` (required), optional `reason`, `confirm`, `approvalId`.

1. Always validates first (`POST /api/agent/commands/validate`).
2. If `confirm` is not true, returns `{ phase: "validation", ... }` — read `riskLevel` before continuing.
3. If `confirm` is true, executes (`POST /api/agent/commands/execute`).

### Human queue

| Tool | Purpose |
|---|---|
| `platform_list_pending_commands` | Pending destructive commands (human JWT) |
| `platform_approve_command` | Approve by `id` |
| `platform_reject_command` | Reject by `id` (optional `reason`) |

### `platform_deploy`

Application deploy (`POST /api/deploy`). `projectId` and `confirm: true` are required. Do not set `confirm` until you have checked environment, branch, and image tag.

## Risk tiers

| Tier | Examples | Requirements |
|---|---|---|
| Read-only | `kubectl get`, `kubectl logs`, status | Agent token; auto-approved |
| Mutating | rollout restart, scale, apply | Agent token; often a `reason` |
| Destructive | delete resources, drain, drop databases | Human approve, then `confirm` + `approvalId` |

## Denied patterns

Validation rejects (among others):

- Recursive `rm -rf /` or broad filesystem wipes
- Disabling authentication or RBAC
- Exfiltrating secrets off approved paths
- Arbitrary curl/wget to unknown hosts that do not match policy

## MCP resources

| URI | Content |
|---|---|
| `platform://openapi` | Live OpenAPI JSON |
| `platform://command-policy` | Risk tiers and denied patterns (markdown) |

## Errors

- **401** — missing or expired credentials; set `PLATFORM_AGENT_TOKEN` or `platform_login`
- **403** — scope/role/policy denial
- **409** — a pending approval already exists for that command
