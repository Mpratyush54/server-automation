# SERVER-automation — agent instructions

## Cursor Cloud specific instructions

Use this section when running as a **Cloud Agent** (remote VM), not on a developer laptop.

### Environment

- Node 22, Go 1.22, Docker, and `gh` are pre-installed via [`.cursor/Dockerfile`](.cursor/Dockerfile).
- Dependencies are installed by [`.cursor/install.sh`](.cursor/install.sh) during Cloud Builds.
- Do **not** use Windows paths or PowerShell — the cloud VM is Ubuntu.

### Active implementation plan: AI-first MCP access

Execute the full plan end-to-end with **zero test/build errors**, then cut release **v0.3.14**.

#### Phase 1 — Backend agent tokens + auth

1. Add [`platform/api/src/entities/AgentToken.ts`](platform/api/src/entities/AgentToken.ts) and [`AgentCommandApproval.ts`](platform/api/src/entities/AgentCommandApproval.ts).
2. Register entities in [`platform/api/src/config/database.ts`](platform/api/src/config/database.ts).
3. Extend [`platform/api/src/middleware/auth.ts`](platform/api/src/middleware/auth.ts):
   - Authenticate `plat_agent_*` tokens (prefix lookup + bcrypt).
   - Add `requireAgentScope`, `requireHumanJwt`.
4. Add routes:
   - [`platform/api/src/routes/agent-tokens.ts`](platform/api/src/routes/agent-tokens.ts) — CRUD + `GET /agent-tokens/me`
   - [`platform/api/src/routes/agent-commands.ts`](platform/api/src/routes/agent-commands.ts) — validate/execute/pending/approve/reject
5. Add [`platform/api/src/lib/command-guard.ts`](platform/api/src/lib/command-guard.ts) and [`command-exec.ts`](platform/api/src/lib/command-exec.ts).
6. Mount routes in [`platform/api/src/routes/api.ts`](platform/api/src/routes/api.ts).

MCP client paths (must match): see [`platform/mcp-server/src/client.ts`](platform/mcp-server/src/client.ts).

#### Phase 2 — MCP server

- Commit [`platform/mcp-server/`](platform/mcp-server/) with `.gitignore` excluding `node_modules/`.
- Verify: `cd platform/mcp-server && npm run build`.

#### Phase 3 — OpenAPI + skill + docs

- Add [`platform/api/openapi.yaml`](platform/api/openapi.yaml) and serve at `GET /api/openapi.json`.
- Add [`.cursor/skills/platform-mcp/SKILL.md`](.cursor/skills/platform-mcp/SKILL.md).
- Fix stale auth docs in [`platform/portal/src/app/pages/playground/playground.component.ts`](platform/portal/src/app/pages/playground/playground.component.ts) if needed.

#### Phase 4 — Tests (gate)

```bash
cd platform/api && npm test
cd platform/mcp-server && npm run build
```

Add unit tests for command-guard and integration tests for agent tokens/commands.

#### Phase 5 — Commit, tag, push release

- **Exclude** from commits: `.claude/settings.local.json`, `tmp-*.tar`, `node_modules/`.
- Commit message focus: MCP agent tokens, command guard, MCP server.
- Tag and push:

```bash
git tag v0.3.14
git push origin HEAD
git push origin v0.3.14
```

This triggers GoReleaser (`release-platformctl.yml`) and semver Docker images (`docker-build.yml`).

### Verification commands

```bash
cd platform/api && npm test
cd platform/mcp-server && npm run build
cd platformctl && go test ./...
```

### Secrets (configure in Cursor Cloud Agents dashboard)

- `JWT_SECRET`, `POSTGRES_*` — if running integration tests against a real DB
- `GITHUB_TOKEN` — for `gh` release/PR operations (OIDC may also work)

### Do not

- Commit secrets or `.env` files
- Self-approve destructive commands in tests without human JWT
- Skip the v0.3.14 tag — the prior auth fix commit did not create a semver release
