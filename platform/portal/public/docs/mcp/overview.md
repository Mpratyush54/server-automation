# Platform MCP

The Platform MCP server is how **humans** and **AI agents** (Cursor, Claude Desktop, Claude Code, and any MCP client) talk to a running Platform cluster.

It does **not** give the model a raw shell on your server. Every mutating or destructive action goes through:

1. An **agent token** (`plat_agent_*`) with explicit scopes
2. A **command guard** (allowlist + deny list)
3. A **human JWT** for anything destructive (agents cannot self-approve)

Public docs live on the marketing site: [MCP overview](/docs/mcp/overview). The server source is [`platform/mcp-server/`](https://github.com/Mpratyush54/SERVER-automation/tree/master/platform/mcp-server).

## Who this is for

| Audience | Start here |
|---|---|
| Operator installing Cursor / Claude against a cluster | [Setup](/docs/mcp/setup) |
| Anyone who wants the full tool list and risk policy | [Tools & policy](/docs/mcp/tools) |
| AI agents / skill files that must follow the protocol | [For AI agents](/docs/mcp/for-agents) |

## What you get

- **Agent tokens** — `plat_agent_*` secrets created by a human admin/devops. Shown **once**.
- **Guarded commands** — `platform_run_command` always validates first. Read-only can run; mutating needs `confirm` + `reason`; destructive waits in a human queue.
- **Read APIs** — projects, logs, pods, nodes, bootstrap status, audit logs.
- **Deploys** — `platform_deploy` with `confirm: true` only after you checked the target.
- **Live OpenAPI** — `GET /api/openapi.json` and MCP resource `platform://openapi`.
- **Command policy** — MCP resource `platform://command-policy` (same rules the API enforces).

## Mental model

```
AI client (Cursor / Claude)
        │  stdio MCP
        ▼
platform-mcp-server  (this repo: platform/mcp-server)
        │  HTTPS  Authorization: Bearer plat_agent_*  or human JWT
        ▼
Platform API  /api/agent-tokens  /api/agent/commands  /api/projects  …
        │
        ▼
k3s cluster (only via allowlisted commands)
```

## Typical human flow

1. Create an agent token with a human admin/devops login.
2. Point the MCP server at your Platform URL (`https://your-domain` or `https://YOUR_IP`) and `PLATFORM_AGENT_TOKEN`.
3. Ask the agent to check health, list projects, or inspect pods.
4. For cluster commands, the agent **must** call `platform_run_command` with `command` only first.
5. You (or the agent, after you agree) re-call with `confirm: true`.
6. Destructive work: log in with `platform_login`, then approve or reject in the pending queue.

## Typical agent flow

See [For AI agents](/docs/mcp/for-agents). Short version:

- Prefer dedicated tools (`platform_list_pods`, `platform_search_logs`) over shell.
- Never set `confirm: true` until you have shown the validation result.
- Never approve destructive commands with an agent token.
- Never chain shell (`&&`, `|`, `;`, backticks) — the guard rejects it.

## Requirements

- A running Platform API (server install via `platformctl provision`, or local `npm run start`)
- Node.js ≥ 18 to run `platform/mcp-server`
- An agent token for authenticated tools (`platform_health` and OpenAPI work without one)

## Next

- [Setup](/docs/mcp/setup) — tokens, env, Cursor, Claude Desktop, IP-based installs
- [Tools & policy](/docs/mcp/tools)
- [For AI agents](/docs/mcp/for-agents)
- [platformctl CLI](/docs/getting-started/platformctl)
