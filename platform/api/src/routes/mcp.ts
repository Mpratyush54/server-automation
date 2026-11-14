import { Router, Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { AGENT_TOKEN_PREFIX, logAudit, verifyAgentToken } from '../middleware/auth';
import { ACCESS_TOKEN_PREFIX, touchGrant, verifyAccessToken } from '../lib/mcp-oauth';
import {
  AUTHORIZATION_SERVER_METADATA_PATH,
  MCP_PATH,
  MCP_UNCONFIGURED_MESSAGE,
  PROTECTED_RESOURCE_METADATA_PATH,
  authorizationServerMetadata,
  getResourceMetadataUrl,
  protectedResourceMetadata,
} from '../lib/mcp-public-url';
import { MCP_INTERNAL_HEADER, mcpInternalSecret } from '../lib/mcp-internal';
import { loopbackApiBaseUrl } from '../lib/mcp-loopback';
import { PlatformHttpClient, buildMcpServer, registerResources, registerTools } from '../mcp/registry';

/**
 * Remote MCP endpoint (#193), mounted at the site root (not under /api):
 *
 *   POST /mcp                                        Streamable HTTP transport, stateless, JSON responses
 *   GET  /.well-known/oauth-protected-resource[/mcp] RFC 9728 metadata
 *   GET  /.well-known/oauth-authorization-server[/api/oauth]  RFC 8414 metadata
 *
 * Callers authenticate with a remote MCP access token (`cairn_at_*`, from the OAuth flow in
 * routes/oidc.ts) or an agent token (`plat_agent_*`). Anything else gets 401 with a
 * WWW-Authenticate challenge pointing at the resource metadata, which starts the OAuth flow.
 */

const SERVER_INFO = { name: 'cairn', version: '1.0.0' };

const INSTRUCTIONS =
  'Cairn is a self-hosted platform for deploying and running apps. Use these tools to read projects, logs, ' +
  'pods and the audit log, and to run allowlisted cluster commands. Always call platform_run_command without ' +
  'confirm first and read the validation. Destructive commands wait for a person to approve them in the Cairn portal.';

interface McpCaller {
  /** Raw bearer credential, forwarded on loopback API calls (never logged). */
  token: string;
  kind: 'mcp_grant' | 'agent_token';
  id: string;
  name: string;
  userId?: string;
  clientId?: string;
}

type CallerResult = { ok: true; caller: McpCaller } | { ok: false; presented: boolean };

async function authenticateCaller(req: Request): Promise<CallerResult> {
  const header = req.headers.authorization;
  if (!header || !/^Bearer\s+/i.test(header)) return { ok: false, presented: false };
  const token = header.replace(/^Bearer\s+/i, '').trim();
  if (!token || token.length > 300) return { ok: false, presented: true };

  if (token.startsWith(ACCESS_TOKEN_PREFIX)) {
    const principal = await verifyAccessToken(token).catch(() => null);
    if (!principal) return { ok: false, presented: true };
    return {
      ok: true,
      caller: {
        token,
        kind: 'mcp_grant',
        id: principal.grantId,
        name: principal.clientName,
        userId: principal.user.id,
        clientId: principal.clientId,
      },
    };
  }
  if (token.startsWith(AGENT_TOKEN_PREFIX)) {
    const result = await verifyAgentToken(token);
    if (result.ok === false) return { ok: false, presented: true };
    return { ok: true, caller: { token, kind: 'agent_token', id: result.agent.id, name: result.agent.name } };
  }
  // Portal session JWTs and other credentials are not accepted here.
  return { ok: false, presented: true };
}

function principalMeta(caller: McpCaller): Record<string, unknown> {
  return caller.kind === 'mcp_grant'
    ? { mcpGrantId: caller.id, clientId: caller.clientId, clientName: caller.name }
    : { agentTokenId: caller.id, agentTokenName: caller.name };
}

function auditTarget(caller: McpCaller) {
  return caller.kind === 'mcp_grant'
    ? { targetType: 'mcp_grant', targetId: caller.id }
    : { targetType: 'agent_token', targetId: caller.id };
}

function jsonRpcError(res: Response, status: number, code: number, message: string) {
  return res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
}

function isInitialize(body: unknown): { clientName?: string; clientVersion?: string; protocolVersion?: string } | null {
  const messages = Array.isArray(body) ? body : [body];
  for (const m of messages) {
    if (m && typeof m === 'object' && (m as any).method === 'initialize') {
      const params = (m as any).params || {};
      const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, max) : undefined);
      return {
        clientName: text(params.clientInfo?.name, 100),
        clientVersion: text(params.clientInfo?.version, 50),
        protocolVersion: text(params.protocolVersion, 20),
      };
    }
  }
  return null;
}

async function handleMcp(req: Request, res: Response) {
  res.set('Cache-Control', 'no-store');
  const metadataUrl = getResourceMetadataUrl();
  if (!metadataUrl) return jsonRpcError(res, 503, -32000, MCP_UNCONFIGURED_MESSAGE);

  const auth = await authenticateCaller(req);
  if (auth.ok === false) {
    const parts = [`Bearer resource_metadata="${metadataUrl}"`];
    if (auth.presented) parts.push('error="invalid_token"', 'error_description="The access token is invalid, expired or revoked"');
    res.set('WWW-Authenticate', parts.join(', '));
    return jsonRpcError(res, 401, -32001, 'Unauthorized: sign in to Cairn to connect this assistant');
  }
  const caller = auth.caller;

  if (req.method !== 'POST') {
    // Stateless server: no standalone SSE stream (GET) and no sessions to delete (DELETE).
    res.set('Allow', 'POST');
    return jsonRpcError(res, 405, -32000, 'Method not allowed');
  }

  if (caller.kind === 'mcp_grant') void touchGrant(caller.id);

  const init = isInitialize(req.body);
  if (init) {
    await logAudit({
      userId: caller.userId,
      action: 'mcp.connect',
      ...auditTarget(caller),
      metadata: { ...principalMeta(caller), ...init },
      ip: req.ip,
    });
  }

  const api = new PlatformHttpClient({
    baseUrl: await loopbackApiBaseUrl(),
    headers: {
      [MCP_INTERNAL_HEADER]: mcpInternalSecret(),
      'X-Forwarded-For': req.ip || '',
    },
    getToken: () => caller.token,
    timeoutMs: process.env.MCP_TOOL_TIMEOUT_MS,
    longTimeoutMs: process.env.MCP_TOOL_LONG_TIMEOUT_MS,
  });
  const tools = registerTools(api, { mode: 'remote' });
  const resources = registerResources(() => api.fetchOpenApi());
  const server = buildMcpServer(tools, resources, {
    ...SERVER_INFO,
    instructions: INSTRUCTIONS,
    onToolCall: (event) =>
      logAudit({
        userId: caller.userId,
        action: 'mcp.tool_call',
        ...auditTarget(caller),
        metadata: { ...principalMeta(caller), tool: event.name, ok: event.ok, argumentKeys: event.argumentKeys, durationMs: event.durationMs },
        ip: req.ip,
      }),
  });

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err: any) {
    console.error('[mcp] request failed:', err?.message || err);
    if (!res.headersSent) jsonRpcError(res, 500, -32603, 'Internal error');
  }
}

export function buildMcpRouter(): Router {
  const router = Router();

  router.get([PROTECTED_RESOURCE_METADATA_PATH, `${PROTECTED_RESOURCE_METADATA_PATH}${MCP_PATH}`], (_req, res) => {
    const meta = protectedResourceMetadata();
    if (!meta) return res.status(503).json({ error: 'temporarily_unavailable', error_description: MCP_UNCONFIGURED_MESSAGE });
    res.set('Cache-Control', 'public, max-age=300');
    return res.json(meta);
  });

  router.get([AUTHORIZATION_SERVER_METADATA_PATH, `${AUTHORIZATION_SERVER_METADATA_PATH}/api/oauth`], (_req, res) => {
    res.set('Cache-Control', 'public, max-age=300');
    return res.json(authorizationServerMetadata());
  });

  router.all(MCP_PATH, (req, res) => {
    void handleMcp(req, res);
  });

  return router;
}

export default buildMcpRouter;
