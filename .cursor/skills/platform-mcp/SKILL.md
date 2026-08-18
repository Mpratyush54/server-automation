---
name: platform-mcp
description: >
  Use Platform MCP against a Platform PaaS API (agent tokens, guarded commands,
  pending human approval). Apply when PLATFORM_AGENT_TOKEN, platform/mcp-server,
  plat_agent_*, platform_run_command, or MCP docs are involved.
---

# Platform MCP skill (for AI agents)

Follow [docs/mcp/for-agents.md](../../../docs/mcp/for-agents.md) in full. This skill is the short form.

## Connect

Env:

- `PLATFORM_URL` — API base (domain or IP; with or without `/api`)
- `PLATFORM_AGENT_TOKEN` — `plat_agent_*` (create via human `POST /api/agent-tokens`)

```bash
cd platform/mcp-server && npm run build && npm start
```

Smoke (no token needed for health):

```bash
PLATFORM_URL=https://YOUR_DOMAIN npm run smoke
```

## Hard rules

1. Call `platform_health` / `platform_whoami` before mutating anything.
2. Prefer dedicated tools over `platform_run_command`.
3. First `platform_run_command` call: `{ command }` only. Read `riskLevel`.
4. Never `confirm: true` until the human has seen validation.
5. Mutating: `confirm: true` + `reason`.
6. Destructive: human `platform_login` → `platform_list_pending_commands` → `platform_approve_command`. Agents cannot self-approve.
7. No shell chaining (`&&`, `|`, `;`, backticks).
8. Never commit tokens, passwords, or `.env` files.

## Tools (names must match the server)

`platform_login` `platform_logout` `platform_whoami` `platform_health` `platform_bootstrap_status` `platform_list_projects` `platform_get_project` `platform_search_logs` `platform_get_pod_logs` `platform_audit_logs` `platform_list_pods` `platform_list_nodes` `platform_run_command` `platform_list_pending_commands` `platform_approve_command` `platform_reject_command` `platform_deploy`

Resources: `platform://openapi` `platform://command-policy`

## API paths

| Method | Path | Auth |
|--------|------|------|
| GET | `/api/health` | none |
| GET | `/api/openapi.json` | none |
| GET | `/api/agent-tokens/me` | agent or human |
| POST | `/api/agent-tokens` | human admin/devops |
| POST | `/api/agent/commands/validate` | `commands:validate` |
| POST | `/api/agent/commands/execute` | `commands:execute` |
| GET | `/api/agent/commands/pending` | human JWT |
| POST | `/api/agent/commands/:id/approve` | human JWT |
| POST | `/api/agent/commands/:id/reject` | human JWT |
