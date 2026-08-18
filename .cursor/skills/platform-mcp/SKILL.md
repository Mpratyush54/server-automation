---
name: platform-mcp
description: >
  Use Platform MCP agent tokens and guarded commands against the Platform PaaS API.
  Apply when configuring PLATFORM_AGENT_TOKEN, validating/executing agent commands,
  approving destructive commands, or working with platform/mcp-server.
---

# Platform MCP skill

## Credentials

- **Agent token** (`PLATFORM_AGENT_TOKEN`): opaque secret starting with `plat_agent_`.
  Create via `POST /api/agent-tokens` (human admin/devops JWT). The raw token is shown once.
- **Human JWT**: `POST /api/auth/login` with email/username + password. Required for
  listing/approving/rejecting pending commands. Agent tokens cannot self-approve.

## MCP server

```bash
cd platform/mcp-server && npm run build && npm start
```

Env:

- `PLATFORM_URL` — API base (e.g. `http://localhost:3000` or `http://localhost:3000/api`)
- `PLATFORM_AGENT_TOKEN` — `plat_agent_*` secret

## Command workflow

1. `platform_run_command` with `command` only → review validation (`riskLevel`, `approvalId`).
2. Read-only: re-call with `confirm: true` (optional for read in API; MCP always validates first).
3. Mutating: `confirm: true` + `reason`.
4. Destructive: human must `platform_login` → `platform_list_pending_commands` →
   `platform_approve_command` → agent re-runs with `confirm: true`, `reason`, and `approvalId`.

Never approve destructive commands with an agent token.

## Key API paths

| Method | Path | Auth |
|--------|------|------|
| GET | `/api/agent-tokens/me` | agent or human |
| POST | `/api/agent-tokens` | human admin/devops |
| POST | `/api/agent/commands/validate` | agent scope `commands:validate` |
| POST | `/api/agent/commands/execute` | agent scope `commands:execute` |
| GET | `/api/agent/commands/pending` | human JWT only |
| POST | `/api/agent/commands/:id/approve` | human JWT only |
| POST | `/api/agent/commands/:id/reject` | human JWT only |
| GET | `/api/openapi.json` | public |

## Policy resources

MCP resources:

- `platform://openapi` — live OpenAPI
- `platform://command-policy` — risk tiers and denied patterns
