# Connect an AI assistant to Cairn

Copy one address, paste it into your assistant, sign in to Cairn and approve. That is all. It works with Claude, ChatGPT, Cursor, VS Code and Claude Code, and you install nothing.

If you are an AI agent, also read [Rules for AI agents](for-agents.md).

## 1. Copy the connector URL

Your Cairn server's connector URL is your portal address followed by `/mcp`:

```
https://cairn.example.com/mcp
```

The portal shows it with a **Copy** button: open any project, go to **Monitoring**, then **AI agents**, and look at **Connect an AI assistant**.

## 2. Paste it into your assistant

**Claude** (claude.ai and Claude Desktop)

1. Open **Customize**, then **Connectors**.
2. Select **Add**, then **Add custom connector**.
3. Name it `Cairn`, paste the connector URL and select **Continue**.
4. Keep the detected sign-in settings and select **Add**. Sign in to Cairn when asked.
5. In a chat, turn the connector on from the **+** menu, under **Connectors**.

On Team and Enterprise plans an owner adds the connector once in **Organization settings**, **Connectors**. Each person then connects from **Customize**, **Connectors**.

**ChatGPT** (web)

1. Open `chatgpt.com/plugins` and select **Add custom MCP server**.
2. Name it `Cairn` and paste the connector URL as the **Server URL**.
3. Choose **OAuth** for authentication, confirm the warning, and sign in to Cairn when asked.

Your workspace settings may need to allow custom MCP servers.

**Cursor**

Add this to `.cursor/mcp.json` in your project, or to `~/.cursor/mcp.json` for every project:

```json
{
  "mcpServers": {
    "cairn": { "url": "https://cairn.example.com/mcp" }
  }
}
```

Cursor asks you to sign in. Approve the connection in the browser.

**VS Code** (GitHub Copilot chat)

Run **MCP: Add Server** from the command palette, choose **HTTP** and paste the connector URL. Or add this to `.vscode/mcp.json`:

```json
{
  "servers": {
    "cairn": { "type": "http", "url": "https://cairn.example.com/mcp" }
  }
}
```

Start the server when VS Code offers it, then sign in to Cairn.

**Claude Code**

```bash
claude mcp add --transport http cairn https://cairn.example.com/mcp
```

Then type `/mcp` in Claude Code, pick `cairn` and sign in in the browser.

## 3. Sign in and approve

Your browser opens the Cairn sign-in page, then a screen that shows:

- the name the assistant gave itself, and the address you go back to afterwards. Only continue if you started this connection;
- what the assistant may do. Read-only permissions are ticked. Permissions that change things, such as running commands, are not ticked. Permissions your role does not have are greyed out.

Select **Approve**. If your account uses two-factor sign-in, Cairn asks for a code from your authenticator app the first time you approve an assistant, and again if you give it more permissions.

Ask the assistant: "Check Cairn health and list my projects."

## What the assistant can do

- It acts as you, with only the permissions you ticked, and never more than your role allows. If your role is lowered later, the assistant loses those permissions at once.
- It sees only the projects you can see.
- Destructive commands, such as deleting or scaling, wait in **Waiting for approval** on the **AI agents** view until a person approves them.
- It cannot approve commands, deploy, or change users, tokens or settings.

| Permission | Who can grant it |
|---|---|
| See your projects, Read logs | everyone |
| Read the audit log | Admin, DevOps, Tech lead |
| See nodes and pods, See install status | Admin, DevOps |
| Check commands against the policy | Admin, DevOps, Tech lead |
| Run allowed commands | Admin, DevOps |

## Disconnect an assistant

On the **AI agents** view, under **Connected assistants**, select **Disconnect**. The assistant stops working right away. Admins and DevOps see and can disconnect every assistant on the platform. Everyone else sees their own.

## Troubleshooting

| Symptom | Check |
|---|---|
| The assistant says it cannot reach the server | Open `https://<your-domain>/.well-known/oauth-protected-resource` in a browser. It should show JSON. If it shows the portal, upgrade Cairn so the ingress sends `/mcp` to the API. |
| "Remote MCP is not available" | The server has no public domain configured. Install or upgrade with a domain. |
| The sign-in window says the request is not valid | Remove the connector and add it again, so the assistant registers afresh. |
| You are asked for a code on approve | Your account has two-factor sign-in. Enter the code from your authenticator app. |
| A tool answers `403` | The assistant lacks that permission, or your role does not allow it. Disconnect and connect again to grant more. |
| A tool answers `401` | The connection was disconnected or expired. Connect again. |

## Use an agent token instead

For scripts and clients that cannot sign in through a browser, send an agent token as a bearer header to the same connector URL.

1. Create a token on the **AI agents** view, under **Agent tokens** (Admin or DevOps, with two-factor sign-in). Copy the `plat_agent_...` value. It is shown once.
2. Configure the client with the header `Authorization: Bearer plat_agent_...`. For example, in Cursor:

```json
{
  "mcpServers": {
    "cairn": {
      "url": "https://cairn.example.com/mcp",
      "headers": { "Authorization": "Bearer ${env:CAIRN_AGENT_TOKEN}" }
    }
  }
}
```

An agent token is not tied to a person: with **Read every project** it sees every project. Revoke it under **Agent tokens**.

## Run the MCP server locally

You can also run the MCP server on your own computer and let your AI tool start it. It offers two extra tools the remote endpoint does not: `platform_login` for approving commands from the assistant, and `platform_deploy`.

From a copy of the Cairn repository:

```bash
cd platform/mcp-server
npm install
npm run build
```

You need Node.js 18 or later. Then add it to your AI tool. The **AI agents** view shows this config with your server address filled in:

```json
{
  "mcpServers": {
    "platform": {
      "command": "node",
      "args": ["/absolute/path/to/SERVER-automation/platform/mcp-server/dist/index.js"],
      "env": {
        "PLATFORM_URL": "https://cairn.example.com",
        "PLATFORM_AGENT_TOKEN": "plat_agent_..."
      }
    }
  }
}
```

Replace the path in `args` with the real absolute path to `dist/index.js`.

| Variable | Meaning |
|---|---|
| `PLATFORM_URL` | Your server address, with or without `/api`. Default: `http://localhost:3000`. |
| `PLATFORM_AGENT_TOKEN` | The `plat_agent_...` token. |
| `PLATFORM_MCP_TIMEOUT_MS` | Time limit for one API call. Default 15000 (15 s). |
| `PLATFORM_MCP_LONG_TIMEOUT_MS` | Time limit for running a command or a deploy. Default 90000 (90 s). |

Test from a terminal (health does not need a token):

```bash
cd platform/mcp-server
PLATFORM_URL=https://cairn.example.com npm run smoke
```

### Approve a risky command

**In the portal (easiest):** open a project, go to **Monitoring**, then **AI agents**. Under **Waiting for approval**, check the command and select **Approve** or **Reject**. Then tell the assistant to run it again with the approval.

**From the local server:** call `platform_login` with your email and password, then `platform_list_pending_commands` and `platform_approve_command`. This only works for accounts without two-factor sign-in, because `platform_login` cannot enter a code. Never put your password in the config file.

An agent token or a connected assistant cannot list, approve or reject requests. An approval lasts one hour and works only for the token or assistant that asked.

### Deploy from an assistant

`platform_deploy` needs a person's session, so it is only on the local server. Run it without `PLATFORM_AGENT_TOKEN` and call `platform_login` first, with an account that has the Developer, Tech lead, DevOps or Admin role and no two-factor sign-in. Otherwise deploy from the portal.

## How it works

- The connector URL is a remote MCP endpoint served by the Cairn API (Streamable HTTP). Sign-in follows the MCP authorization standard: OAuth 2.1 with PKCE, automatic client registration, and tokens that only work for this endpoint.
- Access tokens last one hour (`MCP_ACCESS_TOKEN_TTL_SEC`). The assistant renews them with a refresh token that can be used once; an unused connection expires after 30 days (`MCP_REFRESH_TOKEN_TTL_SEC`). Cairn stores only hashes of these tokens.
- Assistants that register but are never approved are removed after an hour. Registration is rate limited, and each address can hold only a few unapproved registrations at a time.
- Every connection, approval, disconnect and tool call is written to the audit log.
- The server's public address comes from its configured domain (`DOMAIN`, or `MCP_PUBLIC_URL` to override). Without one, the remote endpoint stays off.
- Tool results pass through a redaction step that removes tokens, passwords and other secrets before the assistant sees them.

## For developers / API

| Method | Path | Who can call it |
|---|---|---|
| POST | `/mcp` | connected assistant (OAuth access token) or agent token |
| GET | `/.well-known/oauth-protected-resource/mcp` | anyone |
| GET | `/.well-known/oauth-authorization-server` | anyone |
| POST | `/api/oauth/register` | anyone (rate limited) |
| POST | `/api/oauth/token`, `/api/oauth/revoke` | registered assistant |
| GET | `/api/mcp/connections` | person: own connections; Admin, DevOps: all |
| DELETE | `/api/mcp/connections/:id` | person: own; Admin, DevOps: any |
| GET | `/api/health`, `/api/openapi.json` | anyone |
| GET | `/api/agent-tokens/me` | agent token or person |
| GET | `/api/agent-tokens` | person: Admin, DevOps |
| POST | `/api/agent-tokens` | person: Admin, DevOps, with a recent second factor |
| GET, PATCH, DELETE | `/api/agent-tokens/:id` | person: Admin, DevOps |
| POST | `/api/agent/commands/validate` | agent token or assistant with `commands:validate`, or person: Admin, DevOps, Tech lead |
| POST | `/api/agent/commands/execute` | agent token or assistant with `commands:execute`, or person: Admin, DevOps |
| GET | `/api/agent/commands/pending` | person only: Admin, DevOps, Tech lead |
| POST | `/api/agent/commands/:id/approve`, `/reject` | person only: Admin, DevOps |

Create an agent token without the portal. The login session must carry a fresh second factor:

```bash
PLATFORM_URL=https://cairn.example.com

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

The `201` response contains `token` once. Optional body fields: `scopes` (array) and `expiresAt` (date). If you send no scopes, the token gets `commands:validate`, `commands:execute`, `projects:read`, `logs:read`, `cluster:read`, `audit:read`, `bootstrap:read`. `replays:read` is never in the default set.
