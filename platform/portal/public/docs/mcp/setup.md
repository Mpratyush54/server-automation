# Connect Cursor or Claude to Cairn

This page helps you create an agent token and connect Cursor, Claude Desktop or Claude Code to your Cairn server. You create the token in the portal: open a project, go to **Monitoring**, then **AI agents**.

If you are an AI agent, also read [Rules for AI agents](for-agents.md).

## 1. Create an agent token

You need the Admin or DevOps role and two-factor sign-in on your account ([Two-factor sign-in](../guides/mfa.md)).

1. Open a project and go to **Monitoring**, then **AI agents**.
2. Under **Agent tokens**, select **Create token**.
3. Enter a **Name** that says who uses it, for example `laptop-cursor`.
4. Optional: set **Expires**. Leave it empty for no expiry.
5. Keep the default **Permissions** unless you want less. **Read session replays** is off by default because recordings hold personal data.
6. Enter the code from your authenticator app when asked.
7. Copy the token (`plat_agent_...`). It is shown once. Store it in a password manager or a local file you never commit.

To cut off an assistant later, select **Revoke** next to its token.

## 2. Build the MCP server

From a copy of the Cairn repository:

```bash
cd platform/mcp-server
npm install
npm run build
```

You need Node.js 18 or later. Your AI tool starts the server itself, so you do not keep it running in a terminal.

## 3. Add it to your AI tool

The **AI agents** view shows a ready-made **Client config**. It looks like this:

```json
{
  "mcpServers": {
    "platform": {
      "command": "node",
      "args": ["/absolute/path/to/SERVER-automation/platform/mcp-server/dist/index.js"],
      "env": {
        "PLATFORM_URL": "https://platform.example.com",
        "PLATFORM_AGENT_TOKEN": "plat_agent_..."
      }
    }
  }
}
```

Replace the path in `args` with the real absolute path to `dist/index.js`.

- **Cursor:** put it in `.cursor/mcp.json` in your project, or in Cursor Settings, MCP. Reload MCP or restart Cursor.
- **Claude Desktop:** put it in `claude_desktop_config.json` (on macOS usually `~/Library/Application Support/Claude/claude_desktop_config.json`). Restart Claude Desktop.
- **Claude Code:** use the same server entry in your Claude Code MCP configuration.

You should now see tools such as `platform_health`, `platform_whoami` and `platform_run_command`.

## 4. Check it works

Ask the assistant: "Run platform_health, then platform_whoami."

Or test from a terminal. Health does not need a token:

```bash
cd platform/mcp-server
PLATFORM_URL=https://platform.example.com npm run smoke
```

## Settings

| Variable | Meaning |
|---|---|
| `PLATFORM_URL` | Your server address, with or without `/api`. Examples: `https://platform.example.com`, `http://203.0.113.10.sslip.io`, `http://localhost:3000`. Default: `http://localhost:3000`. |
| `PLATFORM_AGENT_TOKEN` | The `plat_agent_...` token. |
| `PLATFORM_MCP_TIMEOUT_MS` | Time limit for one API call. Default 15000 (15 s). |
| `PLATFORM_MCP_LONG_TIMEOUT_MS` | Time limit for running a command or a deploy. Default 90000 (90 s). |

## Use a server that has no domain yet

If the server only has an IP address, use its sslip.io name:

```bash
PLATFORM_URL=http://203.0.113.10.sslip.io
# after the server has a certificate:
PLATFORM_URL=https://203.0.113.10.sslip.io
```

If HTTPS fails with a certificate name mismatch, install with a real domain and Let's Encrypt (best), or use `http://` while the server answers on plain HTTP.

## Approve a risky command

Some commands wait for a person: deleting, scaling, applying manifests, Helm upgrades and reading secrets.

**In the portal (easiest):** open a project, go to **Monitoring**, then **AI agents**. Under **Waiting for approval**, check the command and select **Approve** or **Reject**. Then tell the assistant to run it again with the approval.

**From the AI tool:** call `platform_login` with your email and password, then `platform_list_pending_commands` and `platform_approve_command`. This only works for accounts without two-factor sign-in, because `platform_login` cannot enter a code. Never put your password in the config file.

An agent token cannot list, approve or reject requests. An approval lasts one hour and works only for the token that asked.

## Deploy from an assistant

`platform_deploy` needs a person's session, not an agent token. The API refuses agent tokens for deploys. To deploy from an assistant, run the MCP server without `PLATFORM_AGENT_TOKEN` and call `platform_login` first, with an account that has the Developer, Tech lead, DevOps or Admin role and no two-factor sign-in. Otherwise deploy from the portal.

## Troubleshooting

| Symptom | Check |
|---|---|
| No Cairn tools in Cursor | The path to `dist/index.js` is absolute, `npm run build` succeeded, MCP was reloaded. |
| `401` on every tool | `PLATFORM_AGENT_TOKEN` is set, the token is not revoked or expired. |
| Connection refused or timeout | `PLATFORM_URL` is reachable: `curl -sS "$PLATFORM_URL/api/health"`. |
| Certificate errors with an IP address | The certificate does not cover that name. Use the domain, or plain HTTP. |
| `403` on a tool | The token lacks that permission, or the action needs a person (deploy, approvals). |
| Command `denied` | The command is not on the allowlist, or it chains commands. See [Tools and command policy](tools.md). |
| `step_up_required` when creating a token | Your session needs a fresh two-factor code. Enter it when the portal asks, or set up two-factor first. |

## How it works

- The MCP server sends the agent token as `Authorization: Bearer plat_agent_...` on every call.
- When both an agent token and a `platform_login` session exist, normal calls use the agent token. Only the approval tools (`platform_list_pending_commands`, `platform_approve_command`, `platform_reject_command`) use the person's session.
- `platform_login` keeps the session in the MCP server's memory only. It never returns it to the assistant. `platform_logout` clears it.
- Creating a token needs a second factor verified within the last 15 minutes (`MFA_STEP_UP_MAX_AGE_SEC`, default 900 seconds). Agent tokens cannot create tokens.
- If you send no permissions when creating a token through the API, it gets the default set: `commands:validate`, `commands:execute`, `projects:read`, `logs:read`, `cluster:read`, `audit:read`, `bootstrap:read`. `replays:read` is never in the default set. Every replay an agent reads is written to the audit log with the token's id.
- This repository also ships a Cursor skill, [`.cursor/skills/platform-mcp/SKILL.md`](https://github.com/Mpratyush54/SERVER-automation/blob/master/.cursor/skills/platform-mcp/SKILL.md), so agents working in the codebase follow the same rules.
- An example config is in [`platform/mcp-server/mcp.example.json`](https://github.com/Mpratyush54/SERVER-automation/blob/master/platform/mcp-server/mcp.example.json).

## For developers / API

Create a token without the portal. The login session must carry a fresh second factor, so sign in with your password, then complete the code step:

```bash
PLATFORM_URL=https://platform.example.com

CHALLENGE=$(curl -sS -X POST "$PLATFORM_URL/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"YOUR_PASSWORD"}' | jq -r .challengeToken)

TOKEN=$(curl -sS -X POST "$PLATFORM_URL/api/auth/mfa/challenge" \
  -H 'Content-Type: application/json' \
  -d "{\"challengeToken\":\"$CHALLENGE\",\"code\":\"123456\"}" | jq -r .token)

curl -sS -X POST "$PLATFORM_URL/api/agent-tokens" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"laptop-cursor"}'
```

The `201` response contains `token` once. Optional body fields: `scopes` (array) and `expiresAt` (date). Check a token with `GET /api/agent-tokens/me`.

| Method | Path | Who can call it |
|---|---|---|
| GET | `/api/health` | anyone |
| GET | `/api/openapi.json` | anyone |
| GET | `/api/agent-tokens/me` | agent token or person |
| GET | `/api/agent-tokens` | person: Admin, DevOps |
| POST | `/api/agent-tokens` | person: Admin, DevOps, with a recent second factor |
| GET | `/api/agent-tokens/:id` | person: Admin, DevOps |
| PATCH | `/api/agent-tokens/:id` | person: Admin, DevOps (`name`, `scopes`, `isActive`, `expiresAt`) |
| DELETE | `/api/agent-tokens/:id` | person: Admin, DevOps (revokes) |
| POST | `/api/agent/commands/validate` | agent token with `commands:validate`, or person: Admin, DevOps, Tech lead |
| POST | `/api/agent/commands/execute` | agent token with `commands:execute`, or person: Admin, DevOps |
| GET | `/api/agent/commands/pending` | person only: Admin, DevOps, Tech lead |
| POST | `/api/agent/commands/:id/approve` | person only: Admin, DevOps |
| POST | `/api/agent/commands/:id/reject` | person only: Admin, DevOps |
