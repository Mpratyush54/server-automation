# Platform MCP server

Local (stdio) MCP server for the Cairn API. Most people do not need it: every Cairn install serves
the same tools remotely at `https://<your-domain>/mcp` (sign in from the assistant, nothing to install).
Use this package to run the server on your own computer, for example to use `platform_login` or
`platform_deploy`.

The tool and resource definitions are shared with the remote endpoint. The single source is
`platform/api/src/mcp/registry.ts`; `npm run build` copies it into `src/shared/` (generated, not in git)
before compiling, so build from a full checkout of the repository.

User docs:

- [Overview](../../docs/mcp/overview.md)
- [Setup](../../docs/mcp/setup.md)
- [Tools & policy](../../docs/mcp/tools.md)
- [For AI agents](../../docs/mcp/for-agents.md)

## Build

```bash
npm install
npm run build
```

## Run

```bash
export PLATFORM_URL=https://YOUR_DOMAIN   # or http://YOUR_IP
export PLATFORM_AGENT_TOKEN=plat_agent_...
npm start
```

MCP clients should spawn `node dist/index.js` (see `mcp.example.json`).

## Smoke against a live API

```bash
PLATFORM_URL=https://YOUR_DOMAIN npm run smoke
```

Exercises MCP initialize, `tools/list`, `resources/list`, and `platform_health`. Authenticated tools are skipped unless `PLATFORM_AGENT_TOKEN` is set.

## Environment

| Variable | Required | Meaning |
|---|---|---|
| `PLATFORM_URL` | yes for real clusters | API base (domain or IP) |
| `PLATFORM_AGENT_TOKEN` | for authenticated tools | `plat_agent_*` secret |
| `PLATFORM_MCP_TIMEOUT_MS` | no | Per-request timeout for Platform API calls (default `15000`) |
| `PLATFORM_MCP_LONG_TIMEOUT_MS` | no | Timeout for `platform_run_command` execution and `platform_deploy` (default `90000`) |

`platform_login` keeps the human JWT in server memory only and returns `{ ok, user }` — the JWT is never
included in tool output. All tool results and errors are passed through a redactor that replaces
JWTs, `plat_agent_*` / `sdk_live_*` / `sdk_test_*` tokens, `Bearer …` values and password/secret fields
with `[REDACTED]`.
