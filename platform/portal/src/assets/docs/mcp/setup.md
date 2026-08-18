# MCP setup

## 1. Create an agent token

You need a **human** admin or devops JWT (`POST /api/auth/login` with email + password). Agent tokens cannot create other tokens.

```bash
# Login (password is required)
TOKEN=$(curl -sS -X POST https://YOUR_DOMAIN/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"YOUR_PASSWORD"}' | jq -r .token)

curl -sS -X POST https://YOUR_DOMAIN/api/agent-tokens \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "laptop-cursor",
    "scopes": ["commands:validate", "commands:execute"]
  }'
```

The response includes the raw token once (`plat_agent_...`). Store it in a secret manager or a local env file that is **not** committed.

`GET /api/agent-tokens/me` returns the current token identity (agent or human).

## 2. Run the MCP server

From this repository:

```bash
cd platform/mcp-server
npm install
npm run build
export PLATFORM_URL=https://YOUR_DOMAIN
export PLATFORM_AGENT_TOKEN=plat_agent_...
npm start
```

| Env var | Meaning |
|---|---|
| `PLATFORM_URL` | API base, with or without `/api` (e.g. `https://platform.example.com` or `http://localhost:3000`) |
| `PLATFORM_AGENT_TOKEN` | Opaque `plat_agent_*` secret |

The server speaks MCP over stdio (the usual Cursor / Claude Desktop transport).

## 3. Cursor config

In Cursor MCP settings (or `.cursor/mcp.json`), add:

```json
{
  "mcpServers": {
    "platform": {
      "command": "node",
      "args": ["/absolute/path/to/SERVER-automation/platform/mcp-server/dist/index.js"],
      "env": {
        "PLATFORM_URL": "https://YOUR_DOMAIN",
        "PLATFORM_AGENT_TOKEN": "plat_agent_..."
      }
    }
  }
}
```

Restart Cursor (or reload MCP) so the `platform_*` tools appear.

## 4. Human approval (destructive commands)

Destructive work needs a human session **in the same MCP process**:

1. Call `platform_login` with your portal email and password.
2. `platform_list_pending_commands`
3. `platform_approve_command` or `platform_reject_command`
4. The agent re-runs `platform_run_command` with `confirm: true` and the `approvalId`

Do not put your human password in `mcp.json`. Use the login tool when you need to approve.

## Related API

| Method | Path | Auth |
|---|---|---|
| GET | `/api/agent-tokens/me` | agent or human |
| POST | `/api/agent-tokens` | human admin/devops |
| POST | `/api/agent/commands/validate` | agent scope `commands:validate` |
| POST | `/api/agent/commands/execute` | agent scope `commands:execute` |
| GET | `/api/agent/commands/pending` | human JWT only |
| POST | `/api/agent/commands/:id/approve` | human JWT only |
| POST | `/api/agent/commands/:id/reject` | human JWT only |
| GET | `/api/openapi.json` | public |

OpenAPI is also served at `/api/openapi.json` on the API.
