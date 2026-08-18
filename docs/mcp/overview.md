# Platform MCP

The Platform MCP server lets coding agents (Cursor, Claude, and other MCP clients) talk to your Platform API with **scoped agent tokens** and a **command guard**. Destructive commands need a human JWT — agents cannot self-approve them.

Use this when you want an AI assistant to inspect projects, logs, pods, and health, or to run allowlisted cluster commands through `platform_run_command`.

## What you get

- **Agent tokens** (`plat_agent_*`) — create once in the API; the raw secret is shown only at creation.
- **Guarded commands** — validate first, then execute. Read-only is auto-allowed; mutating may need a reason; destructive waits for a human.
- **Live OpenAPI** — `GET /api/openapi.json` and MCP resource `platform://openapi`.
- **Command policy** — MCP resource `platform://command-policy`.

## Typical flow

1. Create an agent token (human admin/devops JWT).
2. Point the MCP server at your Platform URL with `PLATFORM_AGENT_TOKEN`.
3. Call tools: health, projects, logs, pods, then `platform_run_command` with `command` only.
4. Read the validation result (`riskLevel`, optional `approvalId`).
5. Re-call with `confirm: true` (and `reason` / `approvalId` when required).

Never approve destructive commands with an agent token. Log in as a human (`platform_login`), list pending commands, then approve or reject.

## Next

- [Setup](/docs/mcp/setup) — env vars, Cursor config, creating tokens
- [Tools & policy](/docs/mcp/tools) — every MCP tool and risk tiers
- [platformctl CLI](/docs/getting-started/platformctl)
