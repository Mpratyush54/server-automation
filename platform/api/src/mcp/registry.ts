/**
 * Cairn MCP tool and resource registry, shared by both MCP servers:
 *
 *  - the remote endpoint served by the API at /mcp (platform/api/src/routes/mcp.ts), and
 *  - the local stdio server (platform/mcp-server), which copies this file into its src/shared/
 *    folder before compiling (platform/mcp-server/scripts/sync-shared.mjs).
 *
 * This file is the only copy in git. Keep it self-contained: no relative imports, only the MCP
 * SDK (installed in both packages), standard JavaScript and the global fetch API. It must
 * compile as CommonJS (API) and as ESM with strict mode (mcp-server).
 *
 * Tools never touch the database directly. They call the Cairn REST API with the caller's own
 * credential, so every tool goes through the same authentication, scope checks, command guard
 * and human approval as any other API client.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// ---------------------------------------------------------------------------
// Redaction: tool results end up in LLM context, transcripts and logs.
// ---------------------------------------------------------------------------

export const REDACTED = '[REDACTED]';

// Compared after lower-casing and removing '_' / '-'.
const SECRET_KEYS = new Set([
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'sessiontoken',
  'agenttoken',
  'sdktoken',
  'apitoken',
  'plaintexttoken',
  'rawtoken',
  'jwt',
  'authorization',
  'cookie',
  'setcookie',
  'apikey',
  'privatekey',
  'secretkey',
  'clientsecret',
  'passwordhash',
  'tokenhash',
  'secrethash',
]);

const SECRET_KEY_SUFFIXES = ['password', 'passwd', 'secret'];

const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, // JWT
  /\bplat_agent_[A-Za-z0-9_-]+/g,
  /\bcairn_(?:at|rt)_[A-Za-z0-9_-]+/g, // remote MCP access / refresh tokens
  /\bsdk_(?:live|test)_[A-Za-z0-9_-]+/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
];

export function isSecretKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[_-]/g, '');
  if (SECRET_KEYS.has(k)) return true;
  return SECRET_KEY_SUFFIXES.some((suffix) => k.endsWith(suffix));
}

export function redactString(value: string): string {
  let out = value;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

export function redactSecrets(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    const arr = value.map((item) => redactSecrets(item, seen));
    seen.delete(value);
    return arr;
  }

  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    // Scalars under secret-looking keys are dropped; objects are walked (e.g. { token: { id, name } }).
    if (isSecretKey(key) && (typeof inner === 'string' || typeof inner === 'number') && inner !== '') {
      out[key] = REDACTED;
    } else {
      out[key] = redactSecrets(inner, seen);
    }
  }
  seen.delete(value);
  return out;
}

// ---------------------------------------------------------------------------
// HTTP client for the Cairn REST API
// ---------------------------------------------------------------------------

export class PlatformApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    message?: string,
  ) {
    const detail =
      typeof body === 'object' && body !== null && 'error' in body
        ? String((body as { error: unknown }).error)
        : message ?? `Platform API request failed with status ${status}`;
    super(detail);
    this.name = 'PlatformApiError';
  }
}

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_LONG_TIMEOUT_MS = 90_000;

export function parseTimeout(value: string | number | undefined, fallback: number): number {
  const n = typeof value === 'number' ? value : Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Path segments built from tool arguments. encodeURIComponent keeps '.' and '..', which URL
// normalisation would resolve, so those (and empty, overlong or control-character values) are
// refused. Kubernetes names are checked against the DNS-1123 rules.
const DNS1123_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const DNS1123_SUBDOMAIN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;

function badArgument(name: string, rule: string): PlatformApiError {
  return new PlatformApiError(400, { error: `Invalid ${name}: ${rule}` });
}

/** A single URL path segment (e.g. a project id or name). */
export function safePathSegment(value: unknown, name: string): string {
  const v = typeof value === 'string' ? value : '';
  if (!v || v.length > 200 || v === '.' || v === '..' || /[\u0000-\u001f\u007f/\\]/.test(v)) {
    throw badArgument(name, 'must be a single non-empty path segment');
  }
  return encodeURIComponent(v);
}

/** Kubernetes namespace (DNS-1123 label, at most 63 characters). */
export function k8sNamespace(value: unknown): string {
  const v = typeof value === 'string' ? value : '';
  if (v.length > 63 || !DNS1123_LABEL.test(v)) throw badArgument('namespace', 'must be a Kubernetes namespace name (DNS-1123 label)');
  return v;
}

/** Kubernetes object name such as a pod (DNS-1123 subdomain, at most 253 characters). */
export function k8sObjectName(value: unknown, name: string): string {
  const v = typeof value === 'string' ? value : '';
  if (v.length > 253 || !DNS1123_SUBDOMAIN.test(v)) throw badArgument(name, 'must be a Kubernetes object name (DNS-1123 subdomain)');
  return v;
}

export type QueryParams = Record<string, string | number | boolean | undefined | null>;

export interface RequestOptions {
  body?: unknown;
  query?: QueryParams;
  auth?: boolean;
  tokenOverride?: string;
  timeoutMs?: number;
}

export interface PlatformHttpClientOptions {
  baseUrl: string;
  /** Per-request timeout in ms (default 15000). */
  timeoutMs?: number | string;
  /** Timeout for command execution and deploys in ms (default 90000). */
  longTimeoutMs?: number | string;
  /** Extra headers sent on every request (never logged or returned). */
  headers?: Record<string, string>;
  /** Credential for authenticated calls; undefined means "not signed in". */
  getToken?: () => string | undefined;
  /** Message used when an authenticated call is attempted without a credential. */
  missingCredentialMessage?: string;
}

/**
 * Everything the tools need from the API. The remote server implements it over loopback HTTP
 * with the caller's credential; the stdio server over HTTPS with the configured token.
 * The human-only methods exist only on the stdio client (they need a person's session).
 */
export interface PlatformApi {
  whoami(): Promise<unknown>;
  health(): Promise<unknown>;
  bootstrapStatus(): Promise<unknown>;
  listProjects(): Promise<unknown>;
  getProject(id: string): Promise<unknown>;
  searchLogs(query: Record<string, string | number | boolean | undefined>): Promise<unknown>;
  getPodLogs(namespace: string, podName: string): Promise<unknown>;
  auditLogs(): Promise<unknown>;
  listPods(namespace?: string): Promise<unknown>;
  listNodes(): Promise<unknown>;
  validateCommand(command: string): Promise<unknown>;
  executeCommand(params: { command: string; confirm?: boolean; reason?: string; approvalId?: string }): Promise<unknown>;
  fetchOpenApi(): Promise<unknown>;
  deploy?(body: Record<string, unknown>): Promise<unknown>;
  login?(email: string, password: string): Promise<unknown>;
  logout?(): Promise<unknown>;
  listPendingCommands?(): Promise<unknown>;
  approveCommand?(id: string): Promise<unknown>;
  rejectCommand?(id: string, reason?: string): Promise<unknown>;
}

export class PlatformHttpClient implements PlatformApi {
  protected readonly baseUrl: string;
  protected readonly timeoutMs: number;
  protected readonly longTimeoutMs: number;
  private readonly extraHeaders: Record<string, string>;
  private readonly tokenGetter?: () => string | undefined;
  private readonly missingCredentialMessage: string;

  constructor(options: PlatformHttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = parseTimeout(options.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.longTimeoutMs = parseTimeout(options.longTimeoutMs, Math.max(DEFAULT_LONG_TIMEOUT_MS, this.timeoutMs));
    this.extraHeaders = { ...(options.headers ?? {}) };
    this.tokenGetter = options.getToken;
    this.missingCredentialMessage =
      options.missingCredentialMessage ?? 'Unauthorized: No credentials configured.';
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  protected getAuthToken(): string | undefined {
    return this.tokenGetter ? this.tokenGetter() : undefined;
  }

  protected apiPath(path: string): string {
    const normalized = path.startsWith('/') ? path : `/${path}`;
    if (this.baseUrl.endsWith('/api')) {
      return `${this.baseUrl}${normalized}`;
    }
    return `${this.baseUrl}/api${normalized}`;
  }

  async request<T = unknown>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const { body, query, auth = true, tokenOverride } = options;
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const url = new URL(this.apiPath(path));

    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== '') {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const headers: Record<string, string> = { ...this.extraHeaders, Accept: 'application/json' };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const token = tokenOverride ?? (auth ? this.getAuthToken() : undefined);
    if (auth && !token) {
      throw new PlatformApiError(401, { error: this.missingCredentialMessage }, 'Unauthorized: No credentials configured');
    }
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    let response: Response;
    let text: string;
    try {
      response = await fetch(url.toString(), {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await response.text();
    } catch (err) {
      const name = (err as { name?: string } | null)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        const message = `Platform API request timed out after ${timeoutMs}ms: ${method} ${url.pathname}`;
        throw new PlatformApiError(504, { error: message }, message);
      }
      throw err;
    }

    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (response.status === 401) {
      throw new PlatformApiError(401, parsed, 'Unauthorized: Invalid or expired credentials');
    }
    if (!response.ok) {
      throw new PlatformApiError(response.status, parsed);
    }
    return parsed as T;
  }

  async whoami(): Promise<unknown> {
    return this.request('GET', '/agent-tokens/me');
  }

  async health(): Promise<unknown> {
    return this.request('GET', '/health', { auth: false });
  }

  async bootstrapStatus(): Promise<unknown> {
    return this.request('GET', '/bootstrap/status');
  }

  async listProjects(): Promise<unknown> {
    return this.request('GET', '/projects');
  }

  async getProject(id: string): Promise<unknown> {
    return this.request('GET', `/projects/${safePathSegment(id, 'project id')}`);
  }

  async searchLogs(query: Record<string, string | number | boolean | undefined>): Promise<unknown> {
    return this.request('GET', '/logs/search', { query });
  }

  async getPodLogs(namespace: string, podName: string): Promise<unknown> {
    return this.request(
      'GET',
      `/bootstrap/pods/${k8sNamespace(namespace)}/${k8sObjectName(podName, 'pod name')}/logs`,
    );
  }

  async auditLogs(): Promise<unknown> {
    return this.request('GET', '/audit-logs');
  }

  async listPods(namespace?: string): Promise<unknown> {
    return this.request('GET', '/bootstrap/pods', { query: namespace ? { namespace: k8sNamespace(namespace) } : undefined });
  }

  async listNodes(): Promise<unknown> {
    return this.request('GET', '/bootstrap/nodes');
  }

  async validateCommand(command: string): Promise<unknown> {
    return this.request('POST', '/agent/commands/validate', { body: { command } });
  }

  async executeCommand(params: { command: string; confirm?: boolean; reason?: string; approvalId?: string }): Promise<unknown> {
    return this.request('POST', '/agent/commands/execute', { body: params, timeoutMs: this.longTimeoutMs });
  }

  async fetchOpenApi(): Promise<unknown> {
    return this.request('GET', '/openapi.json', { auth: false });
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
};

export type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

export type RegisteredTool = ToolDefinition & { handler: ToolHandler };

/**
 * `local`: the stdio server on a person's computer (agent token from the environment, optional
 * password login for approvals and deploys).
 * `remote`: the /mcp endpoint, where the caller is a connected assistant or an agent token.
 * Approvals and deploys need a person in the portal, so those tools are not offered.
 */
export type ToolMode = 'local' | 'remote';

export interface RegisterToolsOptions {
  mode?: ToolMode;
}

const HINT_401: Record<ToolMode, string> = {
  local: 'Set PLATFORM_AGENT_TOKEN or call platform_login with valid credentials.',
  remote: 'The connection was revoked or expired. Reconnect the assistant to Cairn and approve it again.',
};

export function jsonResult(data: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(redactSecrets(data), null, 2) }],
  };
}

export function toolError(err: unknown, mode: ToolMode = 'local'): ToolResult {
  if (err instanceof PlatformApiError) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            redactSecrets({
              error: err.message,
              status: err.status,
              body: err.body,
              hint: err.status === 401 ? HINT_401[mode] : undefined,
            }),
            null,
            2,
          ),
        },
      ],
    };
  }

  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(redactSecrets({ error: message }), null, 2) }],
  };
}

const EMPTY_SCHEMA: ToolDefinition['inputSchema'] = { type: 'object', properties: {} };

export function registerTools(api: PlatformApi, options: RegisterToolsOptions = {}): RegisteredTool[] {
  const mode: ToolMode = options.mode ?? 'local';
  const fail = (err: unknown) => toolError(err, mode);
  const wrap = (fn: (args: Record<string, unknown>) => Promise<unknown>): ToolHandler => async (args) => {
    try {
      return jsonResult(await fn(args));
    } catch (err) {
      return fail(err);
    }
  };
  const humanOnly = (name: string, call?: () => Promise<unknown>) => {
    if (!call) throw new PlatformApiError(401, { error: `${name} is not available on this server` });
    return call();
  };

  const tools: Array<RegisteredTool & { modes: ToolMode[] }> = [
    {
      modes: ['local'],
      name: 'platform_login',
      description:
        'Authenticate with Platform using email and password. Stores a human JWT in server memory for subsequent API calls; the JWT is never returned. Returns { ok, user }.',
      inputSchema: {
        type: 'object',
        properties: {
          email: { type: 'string', description: 'User email address' },
          password: { type: 'string', description: 'User password' },
        },
        required: ['email', 'password'],
      },
      handler: wrap((args) => humanOnly('platform_login', api.login && (() => api.login!(String(args.email), String(args.password))))),
    },
    {
      modes: ['local'],
      name: 'platform_logout',
      description: 'Clear the in-memory human JWT session. Does not affect PLATFORM_AGENT_TOKEN from the environment.',
      inputSchema: EMPTY_SCHEMA,
      handler: wrap(() => humanOnly('platform_logout', api.logout && (() => api.logout!()))),
    },
    {
      modes: ['local', 'remote'],
      name: 'platform_whoami',
      description:
        mode === 'remote'
          ? 'Return who this assistant acts as: the connected assistant and the person who approved it, or the agent token, with the granted scopes.'
          : 'Return the current authenticated identity. Uses /api/agent-tokens/me for agent tokens or /api/users/me for human JWT.',
      inputSchema: EMPTY_SCHEMA,
      handler: wrap(() => api.whoami()),
    },
    {
      modes: ['local', 'remote'],
      name: 'platform_health',
      description: 'Check Platform API health (GET /api/health). Does not require authentication.',
      inputSchema: EMPTY_SCHEMA,
      handler: wrap(() => api.health()),
    },
    {
      modes: ['local', 'remote'],
      name: 'platform_bootstrap_status',
      description: 'Get Platform bootstrap and infrastructure status (GET /api/bootstrap/status).',
      inputSchema: EMPTY_SCHEMA,
      handler: wrap(() => api.bootstrapStatus()),
    },
    {
      modes: ['local', 'remote'],
      name: 'platform_list_projects',
      description: 'List all projects (GET /api/projects).',
      inputSchema: EMPTY_SCHEMA,
      handler: wrap(() => api.listProjects()),
    },
    {
      modes: ['local', 'remote'],
      name: 'platform_get_project',
      description: 'Get a single project by ID (GET /api/projects/:id).',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Project ID' } },
        required: ['id'],
      },
      handler: wrap((args) => api.getProject(String(args.id))),
    },
    {
      modes: ['local', 'remote'],
      name: 'platform_search_logs',
      description: 'Search application logs (GET /api/logs/search).',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Filter by project ID' },
          environmentId: { type: 'string', description: 'Filter by environment ID' },
          serviceName: { type: 'string', description: 'Filter by service name' },
          level: { type: 'string', description: 'Log level (e.g. info, warn, error)' },
          search: { type: 'string', description: 'Substring search in log messages' },
          limit: { type: 'number', description: 'Max results (default 50)' },
          offset: { type: 'number', description: 'Pagination offset (default 0)' },
        },
      },
      handler: wrap((args) => {
        const query: Record<string, string | number | boolean | undefined> = {};
        for (const key of ['projectId', 'environmentId', 'serviceName', 'level', 'search', 'limit', 'offset']) {
          const v = args[key];
          if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') query[key] = v;
        }
        return api.searchLogs(query);
      }),
    },
    {
      modes: ['local', 'remote'],
      name: 'platform_get_pod_logs',
      description: 'Fetch Kubernetes pod logs (GET /api/bootstrap/pods/:namespace/:podName/logs).',
      inputSchema: {
        type: 'object',
        properties: {
          namespace: { type: 'string', description: 'Kubernetes namespace' },
          podName: { type: 'string', description: 'Pod name' },
        },
        required: ['namespace', 'podName'],
      },
      handler: wrap((args) => api.getPodLogs(String(args.namespace), String(args.podName))),
    },
    {
      modes: ['local', 'remote'],
      name: 'platform_audit_logs',
      description: 'List recent audit log entries (GET /api/audit-logs). Requires DEVOPS or TECH_LEAD role.',
      inputSchema: EMPTY_SCHEMA,
      handler: wrap(() => api.auditLogs()),
    },
    {
      modes: ['local', 'remote'],
      name: 'platform_list_pods',
      description: 'List Kubernetes pods, optionally filtered by namespace (GET /api/bootstrap/pods).',
      inputSchema: {
        type: 'object',
        properties: { namespace: { type: 'string', description: 'Optional Kubernetes namespace filter' } },
      },
      handler: wrap((args) => api.listPods(args.namespace ? String(args.namespace) : undefined)),
    },
    {
      modes: ['local', 'remote'],
      name: 'platform_list_nodes',
      description: 'List Kubernetes cluster nodes (GET /api/bootstrap/nodes).',
      inputSchema: EMPTY_SCHEMA,
      handler: wrap(() => api.listNodes()),
    },
    {
      modes: ['local', 'remote'],
      name: 'platform_run_command',
      description:
        'Validate and execute an agent command. Calls POST /api/agent/commands/validate then POST /api/agent/commands/execute. Set confirm=true for destructive commands after reviewing validation output.' +
        (mode === 'remote'
          ? ' Destructive commands wait for a person to approve them in the Cairn portal (AI agents view); then call again with confirm=true and the approvalId.'
          : ''),
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to run on the platform agent' },
          reason: { type: 'string', description: 'Optional justification for the command' },
          confirm: {
            type: 'boolean',
            description: 'Set true to execute after validation, especially for destructive commands',
          },
          approvalId: {
            type: 'string',
            description: 'Approval ID from a human-approved pending command, if required',
          },
        },
        required: ['command'],
      },
      handler: wrap(async (args) => {
        const command = String(args.command);
        // A call that carries a human approval only executes. Validating again
        // would open a second pending approval for the same command (validate
        // does that for destructive commands), left in the portal's list after
        // the command ran and approvable a second time. The execute endpoint
        // validates the command and checks the approval itself.
        const approved = Boolean(args.confirm && args.approvalId);
        const validation = approved ? undefined : await api.validateCommand(command);
        if (!args.confirm) {
          return {
            phase: 'validation',
            validation,
            message: 'Command validated. Re-call with confirm=true to execute.',
          };
        }
        const execution = await api.executeCommand({
          command,
          confirm: true,
          reason: args.reason ? String(args.reason) : undefined,
          approvalId: args.approvalId ? String(args.approvalId) : undefined,
        });
        return { phase: 'execution', validation, execution };
      }),
    },
    {
      modes: ['local'],
      name: 'platform_list_pending_commands',
      description:
        'List commands awaiting human approval (GET /api/agent/commands/pending). Requires a human JWT from platform_login; agent tokens are not supported.',
      inputSchema: EMPTY_SCHEMA,
      handler: wrap(() => humanOnly('platform_list_pending_commands', api.listPendingCommands && (() => api.listPendingCommands!()))),
    },
    {
      modes: ['local'],
      name: 'platform_approve_command',
      description:
        'Approve a pending agent command (POST /api/agent/commands/:id/approve). Requires a human JWT from platform_login.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Pending command approval ID' } },
        required: ['id'],
      },
      handler: wrap((args) => humanOnly('platform_approve_command', api.approveCommand && (() => api.approveCommand!(String(args.id))))),
    },
    {
      modes: ['local'],
      name: 'platform_reject_command',
      description:
        'Reject a pending agent command (POST /api/agent/commands/:id/reject). Requires a human JWT from platform_login.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Pending command approval ID' },
          reason: { type: 'string', description: 'Optional rejection reason' },
        },
        required: ['id'],
      },
      handler: wrap((args) =>
        humanOnly(
          'platform_reject_command',
          api.rejectCommand && (() => api.rejectCommand!(String(args.id), args.reason ? String(args.reason) : undefined)),
        ),
      ),
    },
    {
      modes: ['local'],
      name: 'platform_deploy',
      description:
        'Trigger a deployment (POST /api/deploy). Set confirm=true before submitting destructive or production deployments.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Project ID' },
          environmentId: { type: 'string', description: 'Target environment ID' },
          version: { type: 'string', description: 'Deployment version tag' },
          branch: { type: 'string', description: 'Git branch to deploy' },
          commitSha: { type: 'string', description: 'Git commit SHA' },
          imageTag: { type: 'string', description: 'Container image tag' },
          environmentName: { type: 'string', description: 'Environment name (e.g. preview)' },
          gitPath: { type: 'string', description: 'Path within the git repository' },
          pullFromGit: { type: 'boolean', description: 'Whether to pull latest from git' },
          metadata: { type: 'object', description: 'Additional deployment metadata' },
          confirm: { type: 'boolean', description: 'Must be true to execute the deployment request' },
        },
        required: ['projectId', 'confirm'],
      },
      handler: async (args) => {
        if (args.confirm !== true) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    error: 'Deployment not submitted: confirm must be true.',
                    hint: 'Review parameters and call platform_deploy again with confirm=true.',
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
        try {
          const { confirm: _confirm, ...body } = args;
          return jsonResult(await humanOnly('platform_deploy', api.deploy && (() => api.deploy!(body))));
        } catch (err) {
          return fail(err);
        }
      },
    },
  ];

  return tools
    .filter((t) => t.modes.includes(mode))
    .map(({ modes: _modes, ...tool }) => tool);
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

export const COMMAND_POLICY_MARKDOWN = `# Platform Agent Command Policy

This document describes how MCP agents should use \`platform_run_command\` safely against the Platform PaaS.

## Authentication

- **Connected assistant** (remote \`/mcp\` endpoint, signed in through the browser): acts for the person who approved it, limited to the permissions they ticked and never more than their role allows.
- **Agent token** (\`plat_agent_*\`, \`PLATFORM_AGENT_TOKEN\` or a Bearer header): credential for automated agents. Can validate and execute allowlisted commands.
- **Human JWT** (\`platform_login\`, local server only): required for approving pending commands and other human-in-the-loop actions.

## Command workflow

1. Call \`platform_run_command\` with \`command\` only.
2. Review the **validation** response (risk level, matched policy, required approvals).
3. If validation passes and execution is appropriate, call again with \`confirm: true\` and an optional \`reason\`.

Never set \`confirm: true\` without reading validation output first.

## Risk tiers

| Tier | Examples | Requirements |
|------|----------|--------------|
| Read-only | \`kubectl get\`, \`kubectl logs\`, status checks | Agent credential; auto-approved |
| Mutating | rollout restart, scale, config apply | Agent credential; may require \`reason\` |
| Destructive | delete resources, drain nodes, drop databases | A person approves it in the portal (AI agents view) |

## Destructive commands

Destructive commands return a pending approval ID from validation. A person must approve it:

- In the Cairn portal: open a project, **Monitoring**, **AI agents**, **Waiting for approval**, then **Approve**.
- Or, with the local server only: \`platform_login\`, \`platform_list_pending_commands\`, \`platform_approve_command\`.

Then re-run \`platform_run_command\` with \`confirm: true\` and the \`approvalId\`.

## Deployments

Use \`platform_deploy\` (local server, signed in as a person) for application releases, not raw shell commands when a deploy API exists.

- Always pass \`confirm: true\` only after verifying \`projectId\`, \`environmentId\`, branch, and image tag.
- Production deploys should include a clear change reason in deployment metadata when supported.

## Denied patterns

Commands matching any of the following are rejected at validation:

- Recursive \`rm -rf /\` or broad filesystem wipes
- Disabling authentication or RBAC
- Exfiltration of secrets outside approved paths
- Arbitrary curl/wget to unknown external hosts without policy match

## Error handling

- **401**: missing, revoked or expired credentials. Reconnect the assistant, or check the agent token.
- **403**: insufficient role, scope or policy denial. Escalate to a human operator.
- **409**: pending approval already exists for the same command scope.

## Observability

All executed commands and remote tool calls are audit-logged. Use \`platform_audit_logs\` and \`platform_search_logs\` to trace agent activity.
`;

export type ResourceDefinition = {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  read: () => Promise<string>;
};

export function registerResources(fetchOpenApi: () => Promise<unknown>): ResourceDefinition[] {
  return [
    {
      uri: 'platform://openapi',
      name: 'Platform OpenAPI Specification',
      description: 'Live OpenAPI document fetched from GET /api/openapi.json',
      mimeType: 'application/json',
      read: async () => JSON.stringify(await fetchOpenApi(), null, 2),
    },
    {
      uri: 'platform://command-policy',
      name: 'Platform Agent Command Policy',
      description: 'Static policy guide for safe agent command execution',
      mimeType: 'text/markdown',
      read: async () => COMMAND_POLICY_MARKDOWN,
    },
  ];
}

// ---------------------------------------------------------------------------
// MCP server wiring (same handlers for stdio and Streamable HTTP)
// ---------------------------------------------------------------------------

export interface ToolCallEvent {
  name: string;
  ok: boolean;
  /** Names of the arguments the client sent (never their values). */
  argumentKeys: string[];
  durationMs: number;
}

export interface BuildServerOptions {
  name: string;
  version: string;
  instructions?: string;
  /** Called after every tool call (audit). Errors thrown here are ignored. */
  onToolCall?: (event: ToolCallEvent) => void | Promise<void>;
}

export function buildMcpServer(
  tools: RegisteredTool[],
  resources: ResourceDefinition[],
  options: BuildServerOptions,
): Server {
  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
  const resourceMap = new Map(resources.map((resource) => [resource.uri, resource]));

  const server = new Server(
    { name: options.name, version: options.version },
    {
      capabilities: { tools: {}, resources: {} },
      ...(options.instructions ? { instructions: options.instructions } : {}),
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const started = Date.now();
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const tool = toolMap.get(request.params.name);
    let result: ToolResult;
    if (!tool) {
      result = {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${request.params.name}` }, null, 2) }],
      };
    } else {
      try {
        result = await tool.handler(args);
      } catch (err) {
        result = toolError(err);
      }
    }
    if (options.onToolCall) {
      try {
        await options.onToolCall({
          name: String(request.params.name).slice(0, 100),
          ok: !result.isError,
          argumentKeys: Object.keys(args).slice(0, 20).map((k) => k.slice(0, 50)),
          durationMs: Date.now() - started,
        });
      } catch {
        /* auditing must never break the tool call */
      }
    }
    return result;
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: resources.map(({ uri, name, description, mimeType }) => ({ uri, name, description, mimeType })),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const resource = resourceMap.get(request.params.uri);
    if (!resource) {
      throw new Error(`Unknown resource: ${request.params.uri}`);
    }
    try {
      const text = await resource.read();
      return { contents: [{ uri: resource.uri, mimeType: resource.mimeType, text }] };
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err));
    }
  });

  return server;
}
