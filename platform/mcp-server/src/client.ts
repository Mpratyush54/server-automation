import {
  DEFAULT_LONG_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  PlatformApiError,
  PlatformHttpClient,
  safePathSegment,
} from './shared/registry.js';

export { DEFAULT_LONG_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, PlatformApiError };

export interface PlatformClientOptions {
  baseUrl?: string;
  agentToken?: string;
  /** Per-request timeout in ms (default: PLATFORM_MCP_TIMEOUT_MS or 15000). */
  timeoutMs?: number;
  /** Timeout for long-running calls such as command execution and deploys (default: PLATFORM_MCP_LONG_TIMEOUT_MS or 90000). */
  longTimeoutMs?: number;
}

/**
 * Client for the local stdio server: an agent token from PLATFORM_AGENT_TOKEN and/or a person's
 * session from platform_login, kept in process memory only. Shared HTTP behaviour (timeouts,
 * error mapping, read-only calls) comes from PlatformHttpClient in the shared registry.
 */
export class PlatformClient extends PlatformHttpClient {
  private readonly envAgentToken?: string;
  private sessionJwt: string | null = null;

  constructor(options: PlatformClientOptions = {}) {
    super({
      baseUrl: options.baseUrl ?? process.env.PLATFORM_URL ?? 'http://localhost:3000',
      timeoutMs: options.timeoutMs ?? process.env.PLATFORM_MCP_TIMEOUT_MS,
      longTimeoutMs: options.longTimeoutMs ?? process.env.PLATFORM_MCP_LONG_TIMEOUT_MS,
      missingCredentialMessage:
        'Unauthorized: No credentials configured. Set PLATFORM_AGENT_TOKEN or call platform_login.',
    });
    this.envAgentToken = options.agentToken ?? process.env.PLATFORM_AGENT_TOKEN;
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

  protected override getAuthToken(): string | undefined {
    return this.envAgentToken ?? this.sessionJwt ?? undefined;
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

  override async whoami(): Promise<unknown> {
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

  private requireHuman(tool: string, action: string): string {
    if (!this.sessionJwt) {
      throw new PlatformApiError(
        401,
        {
          error: `Unauthorized: ${tool} requires a human JWT from platform_login. Agent tokens cannot ${action}.`,
        },
        'Human JWT required',
      );
    }
    return this.sessionJwt;
  }

  async listPendingCommands(): Promise<unknown> {
    const jwt = this.requireHuman('platform_list_pending_commands', 'list pending approvals');
    return this.request('GET', '/agent/commands/pending', { tokenOverride: jwt });
  }

  async approveCommand(id: string): Promise<unknown> {
    const jwt = this.requireHuman('platform_approve_command', 'approve commands');
    return this.request('POST', `/agent/commands/${safePathSegment(id, 'approval id')}/approve`, {
      body: {},
      tokenOverride: jwt,
    });
  }

  async rejectCommand(id: string, reason?: string): Promise<unknown> {
    const jwt = this.requireHuman('platform_reject_command', 'reject commands');
    return this.request('POST', `/agent/commands/${safePathSegment(id, 'approval id')}/reject`, {
      body: reason ? { reason } : {},
      tokenOverride: jwt,
    });
  }

  async deploy(body: Record<string, unknown>): Promise<unknown> {
    return this.request('POST', '/deploy', { body, timeoutMs: this.longTimeoutMs });
  }
}
