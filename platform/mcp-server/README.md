# Platform MCP server

stdio MCP server for the Platform PaaS API. User docs:

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
