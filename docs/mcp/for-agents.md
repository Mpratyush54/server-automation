# Rules for AI agents

This page is the protocol an AI agent must follow when it uses the Cairn MCP tools. People should start with [Let an AI assistant work with your server](overview.md) and [Connect an AI assistant](setup.md). Cursor loads the same rules from [`.cursor/skills/platform-mcp/SKILL.md`](https://github.com/Mpratyush54/SERVER-automation/blob/master/.cursor/skills/platform-mcp/SKILL.md).

Treat every rule here as a hard limit, not a suggestion.

## Start of a session

1. Call `platform_health` if you do not know whether the server is reachable.
2. Call `platform_whoami` to learn whether you hold an agent token or a person's session, and which scopes you have.
3. Read the resource `platform://command-policy`. Read `platform://openapi` only when you need request shapes.

## Who you are

1. If `PLATFORM_AGENT_TOKEN` is set, you are an **agent**. You may use the read tools and check and run allowlisted commands, within your token's scopes.
2. `platform_login` creates a **person's** session in the same MCP process. Use it only when a person gave you their credentials for this purpose. It fails for accounts with two-factor sign-in.
3. You **must not** approve or reject requests with an agent token. The API refuses it (`403`).
4. You **must not** invent, guess or reuse tokens or passwords from chat logs, files or earlier sessions.

## Pick the narrowest tool

| Goal | Tool |
|---|---|
| Is the server up? | `platform_health` |
| Who am I? | `platform_whoami` |
| List or inspect projects | `platform_list_projects`, `platform_get_project` |
| App logs | `platform_search_logs` |
| Pods and nodes | `platform_list_pods`, `platform_list_nodes` |
| One pod's logs | `platform_get_pod_logs` |
| Install and component status | `platform_bootstrap_status` |
| Audit trail | `platform_audit_logs` |
| API shape | resource `platform://openapi` |
| Which commands are legal | resource `platform://command-policy` and [Tools and command policy](tools.md) |
| Run a cluster command | `platform_run_command` (see below) |
| Deploy an app | `platform_deploy`, only with a person's session and after review |

Do not use `platform_run_command` with `kubectl get pods` when `platform_list_pods` does the job.

## How to run a command

```
[ draft one command ]
      │
      ▼
platform_run_command({ command })            # no confirm
      │
      ▼
read validation: allowed, riskLevel, matchedPolicy,
                 requiresConfirm, requiresReason, requiresHumanApproval, approvalId
      │
      ├── allowed = false  → stop. Explain matchedPolicy. Do not retry with confirm.
      ├── read, no approval → you may call again with confirm: true
      ├── needs a reason, no approval → tell the person, then confirm: true + reason
      └── requiresHumanApproval → a person approves, then confirm: true + reason + approvalId
```

- **Never** send `confirm: true` on the first call.
- **Never** send `confirm: true` without showing or summarising the validation result to the person.
- **Never** chain commands: no `&&`, `|`, `;`, backticks or `$(`. One command per call.
- Put the subcommand right after the program name: `kubectl get pods -n platform`, not `kubectl -n platform get pods`.
- Do not use flags that switch cluster or identity (`--kubeconfig`, `--server`, `--token`, `--as` and similar). They are refused.

## Commands that need a person

These need approval: `kubectl delete`, `drain`, `cordon`, `uncordon`, `apply`, `create`, `patch`, `edit`, `scale`; `helm upgrade`, `install`, `rollback`, `uninstall`, `delete`, `get`; `platformctl destroy`, `teardown`, `reset`; and any `kubectl get` that prints secret contents.

Sequence:

1. `platform_run_command({ command })`. The result has `requiresHumanApproval: true` and an `approvalId`.
2. Tell the person exactly what will change and wait.
3. The person approves in the portal (project page, **Monitoring**, **AI agents**, **Waiting for approval**), or in this session with `platform_login`, `platform_list_pending_commands`, `platform_approve_command`.
4. `platform_run_command({ command, confirm: true, reason, approvalId })` with the exact same command.

Facts to respect:

- An approval works only for the token (or person) that asked, only for that exact command, only once, and only for one hour.
- Checking the same command again while it is still pending returns the same `approvalId`. Do not loop on validation; ask the person to act.
- The confirm call checks the command again, which opens one more pending request. Mention it to the person; they can reject it.
- If no one can approve in this session, **stop** and ask the person to approve in the portal. Never work around the queue.

## Deploys

`platform_deploy` needs `projectId` and `confirm: true`. The API refuses agent tokens for deploys, so it works only with a person's session from `platform_login` (Developer, Tech lead, DevOps or Admin) and with no `PLATFORM_AGENT_TOKEN` set. Before confirming, check the environment (`environmentId` or `environmentName`), branch and image tag with the person. A production deploy needs an explicit go-ahead from the person in the conversation.

## What you must not do

- Approve your own requests, or ask for an approval you do not need.
- Put passwords or `plat_agent_*` values in git, tickets, chat summaries or screenshots.
- Try `rm -rf /`, `dd`, `mkfs`, `DROP DATABASE`, fork bombs or sending secrets out. They are refused even if a person asks; refuse and cite the policy.
- Turn off authentication or RBAC, or delete cluster roles or role bindings.
- Call `curl` or `wget` on hosts other than `localhost`, `127.0.0.1`, `ghcr.io` or `github.com`. (These programs are not on the allowlist anyway.)
- Say a command ran when you only validated it. Check `phase: "execution"` and `result.ok` in the answer.

## Reading results

- `phase: "validation"` means nothing ran.
- `phase: "execution"` contains `result` with `ok`, `exitCode`, `stdout`, `stderr`, `durationMs`. `result.dryRun: true` means the server only simulated it.
- Secrets in results appear as `[REDACTED]`. Do not try to recover them.

## Errors

| Status or field | What to do |
|---|---|
| `401` | Ask for `PLATFORM_AGENT_TOKEN` or a `platform_login`. Do not retry blindly. |
| `403` | Missing scope, too low a role, refused command, or an approval that is not approved yet, expired or belongs to someone else. Explain and escalate to a person. |
| `409` | The approval was already used or changed state. Validate again only if the person wants to retry. |
| `400` | Add the missing `confirm` or `reason`, or use the exact command that was approved. |
| `504` | The call timed out. Check status with a read tool before retrying a change. |
| `matchedPolicy: no-matching-policy` | The command is not allowlisted. Use an allowed form or a dedicated tool. |
| `matchedPolicy: deny-shell-chaining` | Split it into separate single commands. |

## Example: read only

```
platform_health()
platform_whoami()
platform_list_pods({ namespace: "platform" })
platform_run_command({ command: "kubectl get deploy -n platform" })
# show the validation result
platform_run_command({ command: "kubectl get deploy -n platform", confirm: true })
```

## Example: restart a deployment

```
platform_run_command({ command: "kubectl rollout restart deploy/platform-api -n platform" })
# show the result, wait for the person to agree
platform_run_command({
  command: "kubectl rollout restart deploy/platform-api -n platform",
  confirm: true,
  reason: "pick up rotated secrets"
})
```

## Example: delete a pod

```
platform_run_command({ command: "kubectl delete pod web-7d9f -n my-app" })
# → requiresHumanApproval: true, approvalId: "a1b2..."
# tell the person; wait until they approve in the portal
platform_run_command({
  command: "kubectl delete pod web-7d9f -n my-app",
  confirm: true,
  reason: "pod stuck in CrashLoopBackOff, person approved",
  approvalId: "a1b2..."
})
```

## How it works

- Commands are checked by the API, not by the MCP server. The rules live in `platform/api/src/lib/command-guard.ts`. Refusal rules are checked first, then the allowlist.
- The command is split into arguments without a shell and run with `execFile` inside the API pod, so shell features never apply.
- Approval routes require a person's session (`requireHumanJwt`); agent tokens get `403`.
