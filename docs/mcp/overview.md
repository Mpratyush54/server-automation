# Let an AI assistant work with your server

This page helps you connect an AI assistant, such as Cursor, Claude Desktop or Claude Code, to your Cairn server. In the portal, open any project, go to **Monitoring** and pick the **AI agents** view to create a token and approve requests.

Cairn uses MCP (Model Context Protocol, the standard way AI tools call outside services). The assistant gets a fixed set of tools: check health, list projects, read logs, pods and nodes, and run a short list of allowed cluster commands. It never gets a shell on your server.

## Connect an assistant

1. Set up two-factor sign-in on your account if you have not. Creating a token asks for a code from your authenticator app. See [Two-factor sign-in](../guides/mfa.md).
2. In the portal, open a project, go to **Monitoring**, then **AI agents**. Select **Create token**, give it a name such as `laptop-cursor`, and keep the default permissions. Copy the token now. It is shown once.
3. Build the MCP server once, from a copy of the Cairn repository: `cd platform/mcp-server && npm install && npm run build` (Node.js 18 or later).
4. Paste the **Client config** shown on the same page into your AI tool and replace the path with the real path to `dist/index.js`. The config already contains your server address and the new token.
5. Ask the assistant: "Check Cairn health and list my projects."

Steps for each AI tool: [Set up MCP](setup.md).

> [!NOTE]
> Agent tokens work across the whole platform, not only the project you opened. The **AI agents** view sits on the project page for convenience.

## What keeps it safe

- **Its own token.** Each assistant signs in with an agent token that has only the permissions you picked. Revoke it on the **AI agents** view and the assistant stops working right away.
- **An allowlist.** Every command is checked first. Only listed commands run. Chained commands (`&&`, `|`, `;`) and known dangerous commands are always refused.
- **A person for risky changes.** Deleting things, scaling, applying manifests and reading secrets wait in the **Waiting for approval** list on the **AI agents** view. Only a person can approve. An agent token cannot approve anything.

Who can do what in the portal:

| Action | Roles |
|---|---|
| Create and revoke agent tokens | Admin, DevOps |
| See the approval queue | Admin, DevOps, Tech lead |
| Approve or reject a command | Admin, DevOps |

## More

| You want to | Read |
|---|---|
| Connect Cursor, Claude Desktop or Claude Code | [Set up MCP](setup.md) |
| See every tool and which commands are allowed | [Tools and command policy](tools.md) |
| Give your assistant the rules it must follow | [Rules for AI agents](for-agents.md) |

## How it works

```
AI client (Cursor / Claude)
        │  MCP over stdio
        ▼
platform-mcp-server  (platform/mcp-server in this repository)
        │  HTTPS, Authorization: Bearer plat_agent_…  (or a human session from platform_login)
        ▼
Cairn API
        │
        ▼
Kubernetes cluster (only through allowlisted commands)
```

- The MCP server runs on your computer. Your AI tool starts it and talks to it over standard input and output. It calls the Cairn API over HTTPS.
- Agent tokens start with `plat_agent_`. The API stores only a bcrypt hash and a short lookup prefix. The full value is returned once, when the token is created.
- Every tool result passes through a redaction step that removes tokens, passwords and other secrets before the assistant sees it.
- Commands run inside the API pod without a shell, with a minimal environment (none of the API's own secrets), a 60-second limit and at most 2 MB of output.
- Every executed command, approval, rejection and token change is written to the audit log.
- `platform_health` and the OpenAPI resource work without a token. Everything else needs one.

## For developers / API

- Live API description: `GET /api/openapi.json`, also available to the assistant as the MCP resource `platform://openapi`.
- Command policy for the assistant: MCP resource `platform://command-policy`.
- Token endpoints are under `/api/agent-tokens`; command endpoints are under `/api/agent/commands`. The full list is in [Set up MCP](setup.md#for-developers--api).
- Source: [`platform/mcp-server/`](https://github.com/Mpratyush54/SERVER-automation/tree/master/platform/mcp-server).
