import { Component, Input, OnChanges, SimpleChanges, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { StepUpService } from '../../services/step-up.service';
import { MARKETING_HOSTS, isPublicMarketingHost } from '../../guards/public-domain.guard';
import { DialogService, ToastService } from '../../shared/feedback/feedback.service';

export interface AgentTokenView {
  id: string;
  name: string;
  tokenPrefix?: string;
  scopes: string[];
  lastUsedAt?: string | null;
  expiresAt?: string | null;
  revokedAt?: string | null;
  isActive?: boolean;
  createdAt?: string;
}

export interface AgentCommandApproval {
  id: string;
  command: string;
  riskLevel?: string;
  status?: string;
  reason?: string | null;
  matchedPolicy?: string | null;
  requestedByAgentTokenId?: string | null;
  requestedByMcpGrantId?: string | null;
  requestedByUserId?: string | null;
  /** For requests from a connected assistant: its name and the person it acts for. */
  metadata?: { assistantName?: string; actingFor?: { id: string; name: string; email?: string } } | null;
  approvalExpiresAt?: string | null;
  createdAt?: string;
}

/** A connected AI assistant (remote MCP grant) from GET /api/mcp/connections. */
export interface McpConnectionView {
  id: string;
  clientId: string;
  name: string;
  redirectHosts?: string[];
  scopes: string[];
  effectiveScopes?: string[];
  approvedBy?: { id: string; name: string; email: string } | null;
  mine?: boolean;
  createdAt?: string;
  lastUsedAt?: string | null;
}

export type AssistantId = 'claude' | 'chatgpt' | 'cursor' | 'vscode' | 'claude-code';

export interface AssistantGuide {
  id: AssistantId;
  label: string;
  /** Short steps; the connector URL is shown above them. */
  steps: string[];
  /** Optional snippet with the connector URL filled in. */
  snippet?: (url: string) => string;
}

/** Per-assistant steps, checked against each vendor's documentation (2026-11). */
export const ASSISTANT_GUIDES: AssistantGuide[] = [
  {
    id: 'claude',
    label: 'Claude',
    steps: [
      'In Claude, open Customize, then Connectors.',
      'Select Add, then Add custom connector. Name it Cairn and paste the connector URL.',
      'Keep the detected sign-in settings, select Add, then sign in to Cairn and approve.',
      'In a chat, turn the connector on from the + menu, under Connectors.',
    ],
  },
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    steps: [
      'In ChatGPT on the web, open chatgpt.com/plugins and select Add custom MCP server.',
      'Name it Cairn and paste the connector URL as the Server URL.',
      'Choose OAuth for authentication, confirm, and sign in to Cairn when asked.',
    ],
  },
  {
    id: 'cursor',
    label: 'Cursor',
    steps: [
      'Add this to .cursor/mcp.json in your project, or to ~/.cursor/mcp.json for every project.',
      'Cursor asks you to sign in. Approve the connection in the browser.',
    ],
    snippet: (url) => JSON.stringify({ mcpServers: { cairn: { url } } }, null, 2),
  },
  {
    id: 'vscode',
    label: 'VS Code',
    steps: [
      'Run MCP: Add Server from the command palette, choose HTTP and paste the connector URL. Or add this to .vscode/mcp.json.',
      'Start the server when VS Code offers it, then sign in to Cairn and approve.',
    ],
    snippet: (url) => JSON.stringify({ servers: { cairn: { type: 'http', url } } }, null, 2),
  },
  {
    id: 'claude-code',
    label: 'Claude Code',
    steps: [
      'Run this in a terminal.',
      'In Claude Code, type /mcp, pick cairn and sign in to Cairn in the browser.',
    ],
    snippet: (url) => `claude mcp add --transport http cairn ${url}`,
  },
];

interface ScopeOption {
  id: string;
  label: string;
  checked: boolean;
}

/** Same set the API assigns when no scopes are sent (platform/api/src/routes/agent-tokens.ts). */
const DEFAULT_SCOPES: Array<[string, string]> = [
  ['commands:validate', 'Check commands against the policy'],
  ['commands:execute', 'Run allowed commands'],
  ['projects:read', 'Read every project'],
  ['logs:read', 'Read logs'],
  ['cluster:read', 'Read nodes and pods'],
  ['audit:read', 'Read the audit log'],
  ['bootstrap:read', 'Read install status'],
];
/** Opt-in scopes that are never part of the default set. */
const EXTRA_SCOPES: Array<[string, string]> = [
  ['replays:read', 'Read session replays (personal data)'],
];

/**
 * Project "AI agents" view: the connector URL to paste into an AI assistant (remote MCP, #193),
 * the assistants people connected, the platform's agent tokens and the commands waiting for a
 * human decision. Agent tokens and agent commands are platform-wide in the
 * API (no project id), and the UI says so instead of pretending to filter by project.
 */
@Component({
  selector: 'app-project-agents',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule],
  templateUrl: './project-agents.component.html',
  styleUrls: ['./project-section-shared.css', './project-agents.component.css'],
})
export class ProjectAgentsComponent implements OnChanges {
  private dialog = inject(DialogService);
  private toast = inject(ToastService);

  @Input() projectId = '';

  private api = inject(ApiService);
  private auth = inject(AuthService);
  private stepUp = inject(StepUpService);

  /** Admin or devops: list, create and revoke tokens; approve or reject commands. */
  readonly canManage = this.auth.canManageUsers();
  /** Tech lead and above may see the approval queue. */
  readonly canViewPending = this.auth.isTechLeadOrDevOps();

  readonly apiBaseUrl = `${window.location.origin}/api`;
  /** Address to paste into an AI assistant (remote MCP endpoint of this install). */
  readonly connectorUrl = `${window.location.origin}/mcp`;
  readonly assistants = ASSISTANT_GUIDES;
  activeAssistant: AssistantId = 'claude';

  connections: McpConnectionView[] = [];
  connectionsLoading = false;
  connectionsError = '';
  /** False when the API reports no public address (remote MCP is switched off). */
  remoteConfigured = true;
  disconnectingId = '';
  readonly docsUrl = isPublicMarketingHost()
    ? '/docs/mcp/setup'
    : `https://${MARKETING_HOSTS[0]}/docs/mcp/setup`;

  tokens: AgentTokenView[] = [];
  tokensLoading = false;
  tokensError = '';

  pending: AgentCommandApproval[] = [];
  pendingLoading = false;
  pendingError = '';
  /** Id of the approval currently being approved or rejected. */
  decidingId = '';

  showCreate = false;
  creating = false;
  createError = '';
  newToken = { name: '', expiresAt: '' };
  scopeOptions: ScopeOption[] = [
    ...DEFAULT_SCOPES.map(([id, label]) => ({ id, label, checked: true })),
    ...EXTRA_SCOPES.map(([id, label]) => ({ id, label, checked: false })),
  ];
  /** Plaintext token from the last create; the API never returns it again. */
  createdToken: { name: string; token: string } | null = null;

  revokingId = '';
  copied = '';

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['projectId']) this.load();
  }

  load(): void {
    void this.loadConnections();
    if (this.canManage) void this.loadTokens();
    if (this.canViewPending) void this.loadPending();
  }

  get mcpConfig(): string {
    const token = this.createdToken?.token || 'plat_agent_...';
    return JSON.stringify({
      mcpServers: {
        platform: {
          command: 'node',
          args: ['/absolute/path/to/SERVER-automation/platform/mcp-server/dist/index.js'],
          env: { PLATFORM_URL: window.location.origin, PLATFORM_AGENT_TOKEN: token },
        },
      },
    }, null, 2);
  }

  get assistantGuide(): AssistantGuide {
    return this.assistants.find((a) => a.id === this.activeAssistant) || this.assistants[0];
  }

  assistantSnippet(guide: AssistantGuide): string {
    return guide.snippet ? guide.snippet(this.connectorUrl) : '';
  }

  selectAssistant(id: AssistantId): void {
    this.activeAssistant = id;
  }

  /** Arrow keys move between assistant tabs (WAI-ARIA tabs pattern). */
  onAssistantKey(event: KeyboardEvent): void {
    const i = this.assistants.findIndex((a) => a.id === this.activeAssistant);
    let next = i;
    if (event.key === 'ArrowRight') next = (i + 1) % this.assistants.length;
    else if (event.key === 'ArrowLeft') next = (i - 1 + this.assistants.length) % this.assistants.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = this.assistants.length - 1;
    else return;
    event.preventDefault();
    this.activeAssistant = this.assistants[next].id;
    const list = event.currentTarget as HTMLElement | null;
    setTimeout(() => list?.querySelector<HTMLElement>(`#pa-tab-${this.activeAssistant}`)?.focus());
  }

  async copyText(text: string, what: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.toast.ok(`${what} copied`);
    } catch {
      this.toast.warn('Could not copy. Select the text and copy it yourself.');
    }
  }

  async loadConnections(): Promise<void> {
    this.connectionsLoading = true;
    this.connectionsError = '';
    try {
      const res: any = await firstValueFrom(this.api.getMcpConnections());
      this.connections = Array.isArray(res?.connections) ? res.connections : [];
      this.remoteConfigured = res?.configured !== false;
    } catch (e: any) {
      this.connectionsError = this.message(e, 'Could not load connected assistants. Reload the page to try again.');
    } finally {
      this.connectionsLoading = false;
    }
  }

  async disconnect(c: McpConnectionView): Promise<void> {
    const ok = await this.dialog.confirm({
      title: `Disconnect ${c.name}?`,
      message: c.mine === false && c.approvedBy
        ? `It stops working right away for ${c.approvedBy.name}. They can connect it again later.`
        : 'It stops working right away. You can connect it again later from the assistant.',
      confirmLabel: 'Disconnect',
      danger: true,
    });
    if (!ok) return;
    this.disconnectingId = c.id;
    try {
      await firstValueFrom(this.api.disconnectMcpConnection(c.id));
      this.connections = this.connections.filter((x) => x.id !== c.id);
      this.toast.ok(`${c.name} disconnected`);
    } catch (e: any) {
      this.toast.error(this.message(e, 'Could not disconnect the assistant. Try again.'));
    } finally {
      this.disconnectingId = '';
    }
  }

  /** Assistant name for an approval requested by a connected assistant. */
  connectionName(id?: string | null): string {
    if (!id) return '';
    return this.connections.find((c) => c.id === id)?.name || '';
  }

  tokenState(t: AgentTokenView): 'active' | 'revoked' | 'expired' {
    if (t.revokedAt || t.isActive === false) return 'revoked';
    if (t.expiresAt && new Date(t.expiresAt).getTime() < Date.now()) return 'expired';
    return 'active';
  }

  async loadTokens(): Promise<void> {
    this.tokensLoading = true;
    this.tokensError = '';
    try {
      const res = await firstValueFrom(this.api.getAgentTokens());
      this.tokens = Array.isArray(res) ? res : [];
    } catch (e: any) {
      this.tokensError = this.message(e, 'Could not load agent tokens. Reload the page to try again.');
    } finally {
      this.tokensLoading = false;
    }
  }

  async loadPending(): Promise<void> {
    this.pendingLoading = true;
    this.pendingError = '';
    try {
      const res = await firstValueFrom(this.api.getPendingAgentCommands());
      this.pending = Array.isArray(res) ? res : [];
    } catch (e: any) {
      this.pendingError = this.message(e, 'Could not load commands waiting for approval. Reload the page to try again.');
    } finally {
      this.pendingLoading = false;
    }
  }

  openCreate(): void {
    this.showCreate = true;
    this.createError = '';
  }

  cancelCreate(): void {
    this.showCreate = false;
    this.createError = '';
    this.newToken = { name: '', expiresAt: '' };
  }

  async createToken(): Promise<void> {
    const name = this.newToken.name.trim();
    if (!name) return;
    const scopes = this.scopeOptions.filter((s) => s.checked).map((s) => s.id);
    if (!scopes.length) {
      this.createError = 'Pick at least one permission.';
      return;
    }
    this.creating = true;
    this.createError = '';
    try {
      const body: { name: string; scopes: string[]; expiresAt?: string } = { name, scopes };
      if (this.newToken.expiresAt) body.expiresAt = new Date(this.newToken.expiresAt).toISOString();
      // Minting a token needs a recent second factor (the API answers step_up_required otherwise).
      const res: any = await this.stepUp.run(
        () => firstValueFrom(this.api.createAgentToken(body)),
        'Create an agent token',
      );
      this.createdToken = { name: res?.name || name, token: res?.token || '' };
      this.cancelCreate();
      await this.loadTokens();
    } catch (e: any) {
      this.createError = this.message(e, 'Could not create the token. Try again.');
    } finally {
      this.creating = false;
    }
  }

  dismissCreatedToken(): void {
    this.createdToken = null;
  }

  async revoke(t: AgentTokenView): Promise<void> {
    const ok = await this.dialog.confirm({
      title: `Revoke the token "${t.name}"?`,
      message: 'Agents using it stop working right away. This cannot be undone; create a new token to restore access.',
      confirmLabel: 'Revoke token',
      danger: true,
    });
    if (!ok) return;
    this.revokingId = t.id;
    this.tokensError = '';
    try {
      await firstValueFrom(this.api.revokeAgentToken(t.id));
      await this.loadTokens();
    } catch (e: any) {
      this.tokensError = this.message(e, 'Could not revoke the token. Try again.');
    } finally {
      this.revokingId = '';
    }
  }

  async approve(a: AgentCommandApproval): Promise<void> {
    await this.decide(a, () => firstValueFrom(this.api.approveAgentCommand(a.id)));
  }

  async reject(a: AgentCommandApproval): Promise<void> {
    await this.decide(a, () => firstValueFrom(this.api.rejectAgentCommand(a.id)));
  }

  private async decide(a: AgentCommandApproval, call: () => Promise<unknown>): Promise<void> {
    this.decidingId = a.id;
    this.pendingError = '';
    try {
      await call();
      this.pending = this.pending.filter((p) => p.id !== a.id);
    } catch (e: any) {
      this.pendingError = this.message(e, 'Could not save your decision. Reload the list and try again.');
    } finally {
      this.decidingId = '';
    }
  }

  /** Token name for an approval's requester, when the token list is loaded. */
  tokenName(id?: string | null): string {
    if (!id) return '';
    return this.tokens.find((t) => t.id === id)?.name || '';
  }

  async copy(text: string, key: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.copied = key;
      setTimeout(() => { if (this.copied === key) this.copied = ''; }, 2000);
    } catch { /* clipboard unavailable */ }
  }

  private message(e: any, fallback: string): string {
    return e?.error?.error || fallback;
  }
}
