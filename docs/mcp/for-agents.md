# MCP for AI agents

This page is the protocol for **AI agents** using Platform MCP. Humans should start at [Overview](/docs/mcp/overview) and [Setup](/docs/mcp/setup). Cursor loads the same rules from [`.cursor/skills/platform-mcp/SKILL.md`](https://github.com/Mpratyush54/SERVER-automation/blob/master/.cursor/skills/platform-mcp/SKILL.md).

Treat these as hard constraints, not suggestions.

## Identity

1. If `PLATFORM_AGENT_TOKEN` is set, you are an **agent**. You may validate/execute allowlisted commands and call read APIs.
2. `platform_login` creates a **human** JWT in the same MCP process. Use it only when a human provided credentials and a destructive command is waiting.
3. You **must not** approve or reject pending commands with an agent token. Those routes require a human JWT (`requireHumanJwt`).
4. You **must not** invent, guess, or reuse tokens from chat logs.

Call `platform_health` first when connectivity is unknown, then `platform_whoami`.

## Tool choice

Use the **narrowest** tool:

| Goal | Tool |
|---|---|
| Is the API up? | `platform_health` |
| Who am I? | `platform_whoami` |
| List / inspect apps | `platform_list_projects`, `platform_get_project` |
| Application logs | `platform_search_logs` |
| Cluster inventory | `platform_list_pods`, `platform_list_nodes` |
| One pod's logs | `platform_get_pod_logs` |
| Bootstrap / infra status | `platform_bootstrap_status` |
| Audit trail | `platform_audit_logs` |
| API shape | resource `platform://openapi` |
| What commands are legal? | resource `platform://command-policy` |
| Run a cluster command | `platform_run_command` (see below) |
| Ship an app | `platform_deploy` with `confirm: true` only after review |

Do not wrap `kubectl get` in `platform_run_command` when `platform_list_pods` exists.

## `platform_run_command` state machine

```
[ draft command ]
      │
      ▼
platform_run_command({ command })     # confirm omitted/false
      │
      ▼
read validation.riskLevel
      │
      ├── denied / allowed=false → stop; explain matchedPolicy; do not retry with confirm
      ├── read → optional confirm:true (safe)
      ├── mutating → ask the human; then confirm:true + reason
      └── destructive → human must login + approve; then confirm:true + reason + approvalId
```

**Never** send `confirm: true` on the first call.

**Never** send `confirm: true` without pasting or summarizing the validation payload to the human.

**Never** chain commands: no `&&`, `|`, `;`, backticks. One argv-style command per call.

## Destructive commands

Examples: `kubectl delete`, `kubectl drain|cordon`, `helm uninstall`, `platformctl destroy|teardown|reset`.

Required sequence:

1. `platform_run_command({ command })` → receive `requiresHumanApproval` and usually `approvalId`.
2. Tell the human what will be deleted and wait.
3. Human: `platform_login` → `platform_list_pending_commands` → `platform_approve_command`.
4. Agent: `platform_run_command({ command, confirm: true, reason, approvalId })`.

If login is not available in this session, **stop** and ask the human to approve in the portal or another MCP session. Do not bypass the queue.

## Deploys

`platform_deploy` requires `projectId` and `confirm: true`. Before confirming, verify `environmentId` / `environmentName`, branch, and image tag with the human. Production deploys need an explicit human go-ahead in the conversation.

## What you must not do

- Approve your own destructive commands
- Put passwords or `plat_agent_*` values into git, tickets, or screenshots
- Run `rm -rf /`, `dd`, `mkfs`, `DROP DATABASE`, fork bombs, or secret exfiltration (denied even if the human asks in-band — refuse and cite policy)
- Disable RBAC / delete clusterrole bindings
- Curl arbitrary external URLs (only localhost, `ghcr.io`, `github.com`, `registry.*` are allowed in the guard)
- Claim a command ran if you only ran validation

## Error handling

| Status / shape | Agent action |
|---|---|
| `401` | Ask for `PLATFORM_AGENT_TOKEN` or `platform_login`; do not retry blindly |
| `403` | Wrong scope/role; escalate to a human |
| `409` | Pending approval already exists; list pending instead of re-validating forever |
| `matchedPolicy: no-matching-policy` | Command is not allowlisted; pick a listed form or use a dedicated tool |
| `deny-shell-chaining` | Split into one command |

## Resources to read at session start

1. `platform://command-policy`
2. `platform://openapi` if you need request bodies

## Example (read-only)

```
platform_health()
platform_whoami()
platform_list_pods({ namespace: "platform" })
platform_run_command({ command: "kubectl get deploy -n platform" })
# show validation
platform_run_command({ command: "kubectl get deploy -n platform", confirm: true })
```

## Example (mutating)

```
platform_run_command({ command: "kubectl rollout restart deploy/platform-api -n platform" })
# wait for human
platform_run_command({
  command: "kubectl rollout restart deploy/platform-api -n platform",
  confirm: true,
  reason: "pick up rotated secrets"
})
```
