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

export interface PlatformClientOptions {
  baseUrl?: string;
  agentToken?: string;
  /** Per-request timeout in ms (default: PLATFORM_MCP_TIMEOUT_MS or 15000). */
  timeoutMs?: number;
  /** Timeout for long-running calls such as command execution and deploys (default: PLATFORM_MCP_LONG_TIMEOUT_MS or 90000). */
  longTimeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_LONG_TIMEOUT_MS = 90_000;

function parseTimeout(value: string | number | undefined, fallback: number): number {
  const n = typeof value === 'number' ? value : Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export class PlatformClient {
  private readonly baseUrl: string;
  private readonly envAgentToken?: string;
  private readonly timeoutMs: number;
  private readonly longTimeoutMs: number;
  private sessionJwt: string | null = null;

  constructor(options: PlatformClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.PLATFORM_URL ?? 'http://localhost:3000').replace(
      /\/+$/,
      '',
    );
    this.envAgentToken = options.agentToken ?? process.env.PLATFORM_AGENT_TOKEN;
    this.timeoutMs = parseTimeout(options.timeoutMs ?? process.env.PLATFORM_MCP_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    this.longTimeoutMs = parseTimeout(
      options.longTimeoutMs ?? process.env.PLATFORM_MCP_LONG_TIMEOUT_MS,
      Math.max(DEFAULT_LONG_TIMEOUT_MS, this.timeoutMs),
    );
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  hasAgentToken(): boolean {
    return Boolean(this.envAgentToken);
  }

  hasHumanJwt(): boolean {
    return this.sessionJwt !== null;
  }

  isAuthenticated(): boolean {
    return Boolean(this.getAuthToken());
  }

  setSessionJwt(token: string | null): void {
    this.sessionJwt = token;
  }

  clearSession(): void {
    this.sessionJwt = null;
  }

  private getAuthToken(): string | undefined {
    return this.envAgentToken ?? this.sessionJwt ?? undefined;
  }

  private apiPath(path: string): string {
    const normalized = path.startsWith('/') ? path : `/${path}`;
    if (this.baseUrl.endsWith('/api')) {
      return `${this.baseUrl}${normalized}`;
    }
    return `${this.baseUrl}/api${normalized}`;
  }

  async request<T = unknown>(
    method: string,
    path: string,
    options: {
      body?: unknown;
      query?: Record<string, string | number | boolean | undefined | null>;
      auth?: boolean;
      tokenOverride?: string;
      timeoutMs?: number;
    } = {},
  ): Promise<T> {
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

    const headers: Record<string, string> = {
      Accept: 'application/json',
    };

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const token = tokenOverride ?? (auth ? this.getAuthToken() : undefined);
    if (auth && !token) {
      throw new PlatformApiError(
        401,
        {
          error:
            'Unauthorized: No credentials configured. Set PLATFORM_AGENT_TOKEN or call platform_login.',
        },
        'Unauthorized: No credentials configured',
      );
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

    let parsed: unknown = text;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    } else {
      parsed = null;
    }

    if (response.status === 401) {
      throw new PlatformApiError(401, parsed, 'Unauthorized: Invalid or expired credentials');
    }

    if (!response.ok) {
      throw new PlatformApiError(response.status, parsed);
    }

    return parsed as T;
  }

  /**
   * Log in and keep the human JWT in process memory only. The JWT is never returned,
   * so it cannot leak into MCP tool results, agent transcripts or logs.
   */
  async login(email: string, password: string): Promise<{ ok: true; user: unknown }> {
    const result = await this.request<{ token?: string; user?: unknown }>('POST', '/auth/login', {
      body: { email, password },
      auth: false,
    });
    if (!result || typeof result.token !== 'string' || !result.token) {
      throw new PlatformApiError(502, { error: 'Login response did not contain a session token' });
    }
    this.sessionJwt = result.token;
    return { ok: true, user: result.user ?? null };
  }

  async logout(): Promise<{ ok: true }> {
    this.clearSession();
    return { ok: true };
  }

  async whoami(): Promise<unknown> {
    if (this.envAgentToken) {
      try {
        return await this.request('GET', '/agent-tokens/me');
      } catch (err) {
        if (err instanceof PlatformApiError && err.status === 404) {
          return this.request('GET', '/users/me');
        }
        throw err;
      }
    }
    return this.request('GET', '/users/me');
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
    return this.request('GET', `/projects/${encodeURIComponent(id)}`);
  }

  async searchLogs(query: Record<string, string | number | boolean | undefined>): Promise<unknown> {
    return this.request('GET', '/logs/search', { query });
  }

  async getPodLogs(namespace: string, podName: string): Promise<unknown> {
    return this.request(
      'GET',
      `/bootstrap/pods/${encodeURIComponent(namespace)}/${encodeURIComponent(podName)}/logs`,
    );
  }

  async auditLogs(): Promise<unknown> {
    return this.request('GET', '/audit-logs');
  }

  async listPods(namespace?: string): Promise<unknown> {
    return this.request('GET', '/bootstrap/pods', {
      query: namespace ? { namespace } : undefined,
    });
  }

  async listNodes(): Promise<unknown> {
    return this.request('GET', '/bootstrap/nodes');
  }

  async validateCommand(command: string): Promise<unknown> {
    return this.request('POST', '/agent/commands/validate', { body: { command } });
  }

  async executeCommand(params: {
    command: string;
    confirm?: boolean;
    reason?: string;
    approvalId?: string;
  }): Promise<unknown> {
    return this.request('POST', '/agent/commands/execute', { body: params, timeoutMs: this.longTimeoutMs });
  }

  async listPendingCommands(): Promise<unknown> {
    if (!this.hasHumanJwt()) {
      throw new PlatformApiError(
        401,
        {
          error:
            'Unauthorized: platform_list_pending_commands requires a human JWT from platform_login. Agent tokens cannot list pending approvals.',
        },
        'Human JWT required',
      );
    }
    return this.request('GET', '/agent/commands/pending', {
      tokenOverride: this.sessionJwt!,
    });
  }

  async approveCommand(id: string): Promise<unknown> {
    if (!this.hasHumanJwt()) {
      throw new PlatformApiError(
        401,
        {
          error:
            'Unauthorized: platform_approve_command requires a human JWT from platform_login. Agent tokens cannot approve commands.',
        },
        'Human JWT required',
      );
    }
    return this.request('POST', `/agent/commands/${encodeURIComponent(id)}/approve`, {
      body: {},
      tokenOverride: this.sessionJwt!,
    });
  }

  async rejectCommand(id: string, reason?: string): Promise<unknown> {
    if (!this.hasHumanJwt()) {
      throw new PlatformApiError(
        401,
        {
          error:
            'Unauthorized: platform_reject_command requires a human JWT from platform_login. Agent tokens cannot reject commands.',
        },
        'Human JWT required',
      );
    }
    return this.request('POST', `/agent/commands/${encodeURIComponent(id)}/reject`, {
      body: reason ? { reason } : {},
      tokenOverride: this.sessionJwt!,
    });
  }

  async deploy(body: Record<string, unknown>): Promise<unknown> {
    return this.request('POST', '/deploy', { body, timeoutMs: this.longTimeoutMs });
  }

  async fetchOpenApi(): Promise<unknown> {
    return this.request('GET', '/openapi.json', { auth: false });
  }
}
