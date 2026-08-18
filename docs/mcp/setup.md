# MCP setup

This page is for **operators**: create a token, run the server, and wire Cursor or Claude to your Platform cluster (domain or IP).

AI agents should also read [For AI agents](/docs/mcp/for-agents).

## 1. Create an agent token

You need a **human** admin or devops JWT. Agent tokens cannot create other tokens and cannot approve destructive commands.

```bash
# Password is required (passwordless login is not supported)
PLATFORM_URL=https://YOUR_DOMAIN   # or https://YOUR_IP / http://YOUR_IP:PORT

TOKEN=$(curl -sS -X POST "$PLATFORM_URL/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"YOUR_PASSWORD"}' | jq -r .token)

curl -sS -X POST "$PLATFORM_URL/api/agent-tokens" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "laptop-cursor",
    "scopes": [
      "commands:validate",
      "commands:execute",
      "projects:read",
      "logs:read",
      "cluster:read",
      "audit:read",
      "bootstrap:read"
    ]
  }'
```

The `201` body includes `token` (`plat_agent_...`) **once**. Store it in a secret manager or a local env file that is not committed.

If you omit `scopes`, the API assigns the default set above.

Verify:

```bash
curl -sS "$PLATFORM_URL/api/agent-tokens/me" \
  -H "Authorization: Bearer plat_agent_..."
```

Revoke later with `DELETE /api/agent-tokens/:id` (human admin/devops).

## 2. Build and run the MCP server

From this repository:

```bash
cd platform/mcp-server
npm install
npm run build
export PLATFORM_URL=https://YOUR_DOMAIN
export PLATFORM_AGENT_TOKEN=plat_agent_...
npm start
```

The process speaks **MCP over stdio**. Cursor and Claude spawn it for you; you normally do not keep `npm start` in a terminal.

| Env var | Meaning |
|---|---|
| `PLATFORM_URL` | API base, with or without `/api`. Examples: `https://platform.example.com`, `http://localhost:3000`, `http://148.113.37.157` |
| `PLATFORM_AGENT_TOKEN` | Opaque `plat_agent_*` secret |

`PLATFORM_URL` may be a DNS name or a raw IP. Use `https://` when the ingress has a certificate; use `http://` only if you exposed the API without TLS.

Smoke-test against a live API (health does not need a token):

```bash
cd platform/mcp-server
npm run build
PLATFORM_URL=https://YOUR_DOMAIN npm run smoke
```

## 3. Cursor

Project or user MCP config (`.cursor/mcp.json` or Cursor Settings → MCP):

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

Copy [`platform/mcp-server/mcp.example.json`](https://github.com/Mpratyush54/SERVER-automation/blob/master/platform/mcp-server/mcp.example.json) and fill in the path, URL, and token.

Reload MCP (or restart Cursor). You should see tools named `platform_health`, `platform_whoami`, `platform_run_command`, and the rest.

This repo also ships a Cursor skill at [`.cursor/skills/platform-mcp/SKILL.md`](https://github.com/Mpratyush54/SERVER-automation/blob/master/.cursor/skills/platform-mcp/SKILL.md) so agents in this codebase follow the same protocol.

## 4. Claude Desktop / Claude Code

Claude Desktop (`claude_desktop_config.json`):

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

On macOS that file is typically `~/Library/Application Support/Claude/claude_desktop_config.json`. Restart Claude Desktop after editing.

## 5. Pointing at an IP (no DNS yet)

If the cluster is only reachable by IP (for example a fresh VM):

```bash
export PLATFORM_URL=http://148.113.37.157
# or, once TLS + a certificate exist:
export PLATFORM_URL=https://148.113.37.157
```

Use the same value in `mcp.json`. If HTTPS fails with a certificate name mismatch, either:

- Install with a real domain and Let's Encrypt (preferred), or
- Temporarily use `http://` if the API is exposed that way, or
- Put the IP in `/etc/hosts` as the certificate's DNS name.

Login and token creation still use `$PLATFORM_URL/api/auth/login` and `$PLATFORM_URL/api/agent-tokens`.

## 6. Human approval (destructive commands)

Do **not** put your portal password in `mcp.json`. When a command is destructive:

1. Call `platform_login` with email + password (in the same MCP session).
2. `platform_list_pending_commands`
3. `platform_approve_command` or `platform_reject_command`
4. The agent re-runs `platform_run_command` with `confirm: true`, `reason`, and `approvalId`

Agent tokens **cannot** call approve/reject (the API requires a human JWT).

## Related API

| Method | Path | Auth |
|---|---|---|
| GET | `/api/health` | none |
| GET | `/api/openapi.json` | none |
| GET | `/api/agent-tokens/me` | agent or human |
| POST | `/api/agent-tokens` | human admin/devops |
| GET | `/api/agent-tokens` | human admin/devops |
| PATCH | `/api/agent-tokens/:id` | human admin/devops |
| DELETE | `/api/agent-tokens/:id` | human admin/devops |
| POST | `/api/agent/commands/validate` | agent scope `commands:validate` |
| POST | `/api/agent/commands/execute` | agent scope `commands:execute` |
| GET | `/api/agent/commands/pending` | human JWT only |
| POST | `/api/agent/commands/:id/approve` | human JWT only |
| POST | `/api/agent/commands/:id/reject` | human JWT only |

## Troubleshooting

| Symptom | What to check |
|---|---|
| MCP tools missing in Cursor | Absolute path to `dist/index.js`, `npm run build` succeeded, MCP reloaded |
| `401` on every tool | `PLATFORM_AGENT_TOKEN` set, token not revoked, `Authorization` going to the API host |
| `ECONNREFUSED` / timeout | `PLATFORM_URL` reachable: `curl -sS "$PLATFORM_URL/api/health"` |
| TLS errors against an IP | Certificate CN/SAN does not include the IP; use the domain or HTTP |
| `403` on commands | Token scopes; destructive tools need a human JWT |
| Validation `denied` | Command not on the allowlist, or contains `&&` `\|` `;` `` ` `` |

Health check:

```bash
curl -sS "$PLATFORM_URL/api/health"
curl -sS "$PLATFORM_URL/api/openapi.json" | jq '.info'
```
