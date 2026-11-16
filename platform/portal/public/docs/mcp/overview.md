# Let an AI assistant work with your server

This page helps you connect an AI assistant, such as Claude, ChatGPT, Cursor, VS Code or Claude Code, to your Cairn server. In the portal, open any project, go to **Monitoring** and pick the **AI agents** view to copy the connector URL, see connected assistants and approve requests.

Cairn uses MCP (Model Context Protocol, the standard way AI tools call outside services). The assistant gets a fixed set of tools: check health, list projects, read logs, pods and nodes, and run a short list of allowed cluster commands. It never gets a shell on your server.

## Connect an assistant

1. In the portal, open a project, go to **Monitoring**, then **AI agents**, and copy the **Connector URL** (your portal address followed by `/mcp`).
2. Paste it into your assistant as a custom connector or remote MCP server.
3. Sign in to Cairn in the browser window that opens, check the permissions and select **Approve**.
4. Ask the assistant: "Check Cairn health and list my projects."

Steps for each assistant: [Connect an AI assistant](setup.md).

> [!NOTE]
> A connected assistant acts as you: it sees only your projects and never gets more than your role allows. Agent tokens, the alternative for scripts, work across the whole platform.

## What keeps it safe

- **Its own sign-in.** Each assistant gets only the permissions you ticked when you approved it, capped by your role. Disconnect it on the **AI agents** view and it stops working right away. Agent tokens work the same way: revoke one and its user is cut off.
- **An allowlist.** Every command is checked first. Only listed commands run. Chained commands (`&&`, `|`, `;`) and known dangerous commands are always refused.
- **A person for risky changes.** Deleting things, scaling, applying manifests and reading secrets wait in the **Waiting for approval** list on the **AI agents** view. Only a person can approve. An assistant or agent token cannot approve anything.

Who can do what in the portal:

| Action | Roles |
|---|---|
| Connect an assistant, disconnect your own | everyone |
| See and disconnect every assistant | Admin, DevOps |
| Create and revoke agent tokens | Admin, DevOps |
| See the approval queue | Admin, DevOps, Tech lead |
| Approve or reject a command | Admin, DevOps |

## More

| You want to | Read |
|---|---|
| Connect Claude, ChatGPT, Cursor, VS Code or Claude Code | [Connect an AI assistant](setup.md) |
| See every tool and which commands are allowed | [Tools and command policy](tools.md) |
| Give your assistant the rules it must follow | [Rules for AI agents](for-agents.md) |

## How it works

```
AI assistant (Claude, ChatGPT, Cursor, VS Code, Claude Code)
        │  MCP over HTTPS: https://<your-domain>/mcp
        │  OAuth sign-in (you approve in the portal), or Authorization: Bearer plat_agent_…
        ▼
Cairn API  (same checks, permissions and audit as the portal)
        │
        ▼
Kubernetes cluster (only through allowlisted commands)
```

- The remote MCP endpoint is part of the Cairn API. Nothing runs on your computer. You can still run the MCP server from `platform/mcp-server` locally if you prefer; see [Run the MCP server locally](setup.md#run-the-mcp-server-locally).
- Assistants sign in with OAuth 2.1: they register themselves, you approve them, and they receive short-lived tokens that only work on `/mcp`. Cairn stores only hashes of those tokens.
- Agent tokens start with `plat_agent_`. The API stores only a bcrypt hash and a short lookup prefix. The full value is returned once, when the token is created.
- Every tool result passes through a redaction step that removes tokens, passwords and other secrets before the assistant sees it.
- Commands run inside the API pod without a shell, with a minimal environment (none of the API's own secrets), a 60-second limit and at most 2 MB of output.
- Every executed command, approval, rejection and token change is written to the audit log.
- Every connection, approval, disconnect and tool call of a connected assistant is written to the audit log too.

## For developers / API

- Live API description: `GET /api/openapi.json`, also available to the assistant as the MCP resource `platform://openapi`.
- Command policy for the assistant: MCP resource `platform://command-policy`.
- The remote endpoint is `POST /mcp`; OAuth metadata is at `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server`. Token endpoints are under `/api/agent-tokens`; command endpoints are under `/api/agent/commands`. The full list is in [Connect an AI assistant](setup.md#for-developers--api).
- Source: [`platform/mcp-server/`](https://github.com/Mpratyush54/SERVER-automation/tree/master/platform/mcp-server).
