import { Component, Input, OnChanges, SimpleChanges, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { StepUpService } from '../../services/step-up.service';
import { MARKETING_HOSTS, isPublicMarketingHost } from '../../guards/public-domain.guard';
import { DialogService } from '../../shared/feedback/feedback.service';

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
  requestedByUserId?: string | null;
  approvalExpiresAt?: string | null;
  createdAt?: string;
}

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
 * Project "AI agents" view: how to connect an MCP client, the platform's agent tokens and the
 * commands waiting for a human decision. Agent tokens and agent commands are platform-wide in the
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

  @Input() projectId = '';

  private api = inject(ApiService);
  private auth = inject(AuthService);
  private stepUp = inject(StepUpService);

  /** Admin or devops: list, create and revoke tokens; approve or reject commands. */
  readonly canManage = this.auth.canManageUsers();
  /** Tech lead and above may see the approval queue. */
  readonly canViewPending = this.auth.isTechLeadOrDevOps();

  readonly apiBaseUrl = `${window.location.origin}/api`;
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
