# What an AI assistant can do

This page lists every tool the Cairn MCP server gives an AI assistant, and which cluster commands it may run. You manage the assistant's token and approve its requests in the portal: open a project, go to **Monitoring**, then **AI agents**.

Rules the assistant itself must follow: [Rules for AI agents](for-agents.md).

An assistant connected through the connector URL (`https://<your-domain>/mcp`) gets every tool below except `platform_login`, `platform_logout`, the approval tools and `platform_deploy`, which need a person and are only on the local MCP server. It sees only the projects of the person who approved it.

## Ask the assistant to look around

These tools only read. They are the safest choice and the assistant should prefer them.

| Tool | What it does | Permission it needs |
|---|---|---|
| `platform_health` | Checks that the server answers. | none |
| `platform_whoami` | Shows which token or person the assistant is signed in as. | any |
| `platform_bootstrap_status` | Shows install and component status. | any |
| `platform_list_projects` | Lists projects. | Read every project |
| `platform_get_project` | Shows one project (`id`). | Read every project |
| `platform_search_logs` | Searches app logs. Filters: `projectId`, `environmentId`, `serviceName`, `level`, `search`, `limit` (default 50), `offset`. | Read logs |
| `platform_list_pods` | Lists pods, optionally in one `namespace`. | Read nodes and pods, or Read install status |
| `platform_list_nodes` | Lists cluster nodes. | Read nodes and pods, or Read install status |
| `platform_get_pod_logs` | Shows one pod's logs (`namespace`, `podName`). | Read nodes and pods, Read install status, or Read logs |
| `platform_audit_logs` | Shows recent audit log entries. | Read the audit log |

Example: "List the pods in the `platform` namespace and show the last logs of the API pod."

## Run a cluster command

`platform_run_command` takes one `command`, plus optional `reason`, `confirm` and `approvalId`. It always works in two steps:

1. The assistant sends the command alone. Cairn checks it and answers with the risk level and what is needed. Nothing runs.
2. The assistant sends it again with `confirm: true` (and a `reason` when asked). Now it runs.

Example:

```
platform_run_command({ command: "kubectl get deploy -n platform" })
platform_run_command({ command: "kubectl get deploy -n platform", confirm: true })
```

## Which commands are allowed

Only one command per call. The command name comes first and the subcommand second, with no flags in between (`kubectl get pods -n platform` works, `kubectl -n platform get pods` does not).

### Runs after confirm

- `kubectl get`, `describe`, `top`, `api-resources`, `api-versions`, `version`, `cluster-info`
- `kubectl logs`, `kubectl explain`, `kubectl rollout status`
- `helm status`, `list`, `ls`, `history`, `show`
- `platformctl status`, `version`, `info`, `health`
- `uname`, `hostname`, `uptime`, `df`, `free`, `ps`, `whoami`, `id`, `date`, `pwd`, with only a few simple flags (for example `df -h`, `free -m`, `ps aux`)

### Runs after confirm and a reason

- `kubectl rollout restart`, `undo`, `pause`, `resume`
- `kubectl annotate`, `kubectl label`

### Needs a person's approval, then confirm and a reason

- Changes: `kubectl apply`, `create`, `patch`, `edit`, `scale`; `helm upgrade`, `install`, `rollback`
- Deletes: `kubectl delete`; `kubectl drain`, `cordon`, `uncordon`; `helm uninstall`, `helm delete`; `platformctl destroy`, `teardown`, `reset`
- Reading secrets: `kubectl get secret ... -o yaml` (or any output other than `wide` or `name`), `kubectl get --raw`, `kubectl cluster-info dump`, `helm get`

Anything not listed is refused (`no-matching-policy`).

### Always refused

- Chaining or substitution: `&&`, `;`, `|`, backticks, `$(`
- `rm -rf /` and wiping home or root folders
- `dd` from `/dev/`, `mkfs`
- Turning off authentication or RBAC, or deleting cluster roles and role bindings
- Sending secrets, passwords or tokens out with `curl` or `wget`
- `curl` or `wget` to any host other than `localhost`, `127.0.0.1`, `ghcr.io` or `github.com`
- `kubectl` or `helm` flags that switch cluster or identity, such as `--kubeconfig`, `--server`, `--token`, `--as`, `--insecure-skip-tls-verify`, `--post-renderer`
- `DROP DATABASE`, `DROP SCHEMA`
- Fork bombs and empty commands

## Approve a request

When a command needs a person, the first step returns an `approvalId`. A person with the Admin or DevOps role approves it:

- **In the portal:** **Monitoring**, **AI agents**, **Waiting for approval**, then **Approve** or **Reject**.
- **In the AI tool:** `platform_login` (accounts without two-factor sign-in only), then:

| Tool | What it does |
|---|---|
| `platform_list_pending_commands` | Lists requests waiting for a person. |
| `platform_approve_command` | Approves one request (`id`). |
| `platform_reject_command` | Rejects one request (`id`, optional `reason`). |

Then the assistant runs the command with `confirm: true`, a `reason` and the `approvalId`. An approval lasts one hour, is used once, and works only for the token that asked.

## Sign in as a person

| Tool | What it does |
|---|---|
| `platform_login` | Signs in with `email` and `password`. Needed for approvals. Does not work for accounts with two-factor sign-in. |
| `platform_logout` | Ends that session. The agent token stays. |

## Deploy

`platform_deploy` starts a deployment. It needs `projectId` and `confirm: true`. Optional: `environmentId`, `environmentName`, `version`, `branch`, `commitSha`, `imageTag`, `gitPath`, `pullFromGit`, `metadata`.

It works only with a person's session (Developer, Tech lead, DevOps or Admin), not with an agent token. It is only offered by the local MCP server. See [Deploy from an assistant](setup.md#deploy-from-an-assistant).

## Errors

| Status | Meaning |
|---|---|
| 400 | The command is missing, needs `confirm: true` or a `reason`, or the `approvalId` belongs to a different command. |
| 401 | No credentials, or they expired. Set `PLATFORM_AGENT_TOKEN` or call `platform_login`. |
| 403 | Command refused, token lacks a permission, role too low, approval not yet approved or expired, or the action needs a person. |
| 404 | The approval does not exist. |
| 409 | The approval was already used, or someone else approved or rejected it first. |
| 504 | The call took longer than the MCP server's time limit. |

## How it works

- All tools return JSON text. Errors include `status` and the API's answer; a `401` also includes a hint.
- Tool results are redacted before the assistant sees them: tokens, passwords, cookies and keys become `[REDACTED]`.
- Checking a command that needs approval creates a pending request, or reuses the same token's existing pending request for that command. Pending requests expire after one hour. Approving resets the hour.
- Because `platform_run_command` checks the command again before running it, the second call for an approved command also opens a new pending request. It is harmless; reject it or let it expire.
- Commands run inside the API pod, without a shell, with a 60-second limit, 2 MB of output, and only `PATH`, `HOME`, `KUBECONFIG` and the Kubernetes service address in the environment.
- Mutating and destructive commands are recorded with their result. Every execution is written to the audit log as `agent_command.execute`.
- With `AGENT_COMMAND_DRY_RUN=1` on the API (and always in tests), commands are checked but not run; the result says `[dry-run]`.

## For developers / API

Permission names, as the API uses them:

| Portal label | Scope |
|---|---|
| Check commands against the policy | `commands:validate` |
| Run allowed commands | `commands:execute` |
| Read every project | `projects:read` |
| Read logs | `logs:read` |
| Read nodes and pods | `cluster:read` |
| Read the audit log | `audit:read` |
| Read install status | `bootstrap:read` |
| Read session replays (personal data) | `replays:read` (not in the default set) |

A token with `*` has every scope. Uploading source maps from CI needs the project-bound scope `errors:sourcemaps:<projectId>`; `projects:read` is not enough.

Tool to API mapping:

| Tool | API call |
|---|---|
| `platform_health` | `GET /api/health` |
| `platform_whoami` | `GET /api/agent-tokens/me` (agent token) or `GET /api/users/me` |
| `platform_bootstrap_status` | `GET /api/bootstrap/status` |
| `platform_list_projects` / `platform_get_project` | `GET /api/projects`, `GET /api/projects/:id` |
| `platform_search_logs` | `GET /api/logs/search` |
| `platform_list_pods` / `platform_list_nodes` | `GET /api/bootstrap/pods`, `GET /api/bootstrap/nodes` |
| `platform_get_pod_logs` | `GET /api/bootstrap/pods/:namespace/:podName/logs` |
| `platform_audit_logs` | `GET /api/audit-logs` |
| `platform_run_command` | `POST /api/agent/commands/validate`, then `POST /api/agent/commands/execute` |
| `platform_list_pending_commands` | `GET /api/agent/commands/pending` |
| `platform_approve_command` / `platform_reject_command` | `POST /api/agent/commands/:id/approve`, `.../reject` |
| `platform_deploy` | `POST /api/deploy` |
| `platform_login` | `POST /api/auth/login` |

MCP resources:

| URI | Content |
|---|---|
| `platform://openapi` | The live API description from `GET /api/openapi.json`. |
| `platform://command-policy` | A short guide to risk levels and the approval flow (Markdown). This page is the complete list. |

Source of truth for the allowlist: [`platform/api/src/lib/command-guard.ts`](https://github.com/Mpratyush54/SERVER-automation/blob/master/platform/api/src/lib/command-guard.ts).
