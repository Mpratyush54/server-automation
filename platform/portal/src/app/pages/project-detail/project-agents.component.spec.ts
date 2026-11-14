import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { ProjectAgentsComponent } from './project-agents.component';
import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { StepUpService } from '../../services/step-up.service';
import { DialogService, ToastService } from '../../shared/feedback/feedback.service';

const TOKEN = {
  id: 't1', name: 'laptop-cursor', tokenPrefix: 'plat_agent_ab12', scopes: ['projects:read', 'logs:read'],
  lastUsedAt: '2026-11-10T10:00:00.000Z', expiresAt: null, revokedAt: null, isActive: true, createdAt: '2026-11-01T10:00:00.000Z',
};
const CONNECTION = {
  id: 'g1', clientId: 'mcp_0123', name: 'Claude', redirectHosts: ['https://claude.ai'], scopes: ['projects:read', 'logs:read'],
  approvedBy: { id: 'u1', name: 'Asha', email: 'asha@example.test' }, mine: true, createdAt: '2026-11-14T10:00:00.000Z', lastUsedAt: null,
};
const APPROVAL = {
  id: 'a1', command: 'kubectl delete pod web-1 -n demo', riskLevel: 'destructive', status: 'pending',
  requestedByAgentTokenId: 't1', requestedByUserId: null, approvalExpiresAt: '2026-11-15T11:00:00.000Z', createdAt: '2026-11-15T10:00:00.000Z',
};

describe('ProjectAgentsComponent', () => {
  let api: jasmine.SpyObj<ApiService>;
  let auth: jasmine.SpyObj<AuthService>;
  let stepUp: jasmine.SpyObj<StepUpService>;
  let dialog: jasmine.SpyObj<DialogService>;
  let toast: jasmine.SpyObj<ToastService>;

  function setRole(manage: boolean, viewPending = manage) {
    auth.canManageUsers.and.returnValue(manage);
    auth.isTechLeadOrDevOps.and.returnValue(viewPending);
  }

  async function render() {
    const fixture = TestBed.createComponent(ProjectAgentsComponent);
    fixture.componentRef.setInput('projectId', 'p1');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  const q = (f: any, sel: string): HTMLElement | null => f.nativeElement.querySelector(sel);

  beforeEach(async () => {
    api = jasmine.createSpyObj('ApiService', [
      'getAgentTokens', 'createAgentToken', 'revokeAgentToken',
      'getPendingAgentCommands', 'approveAgentCommand', 'rejectAgentCommand',
      'getMcpConnections', 'disconnectMcpConnection',
    ]);
    dialog = jasmine.createSpyObj('DialogService', ['confirm']);
    dialog.confirm.and.returnValue(Promise.resolve(true));
    toast = jasmine.createSpyObj('ToastService', ['ok', 'warn', 'error', 'info']);
    api.getMcpConnections.and.returnValue(of({ connectorUrl: 'https://cairn.example.test/mcp', configured: true, connections: [CONNECTION] }));
    api.disconnectMcpConnection.and.returnValue(of({ ok: true }));
    auth = jasmine.createSpyObj('AuthService', ['canManageUsers', 'isTechLeadOrDevOps']);
    stepUp = jasmine.createSpyObj('StepUpService', ['run']);
    stepUp.run.and.callFake((action: () => Promise<any>) => action());
    setRole(true);
    api.getAgentTokens.and.returnValue(of([TOKEN]));
    api.getPendingAgentCommands.and.returnValue(of([APPROVAL]));
    api.approveAgentCommand.and.returnValue(of({ ...APPROVAL, status: 'approved' }));
    api.rejectAgentCommand.and.returnValue(of({ ...APPROVAL, status: 'rejected' }));

    await TestBed.configureTestingModule({
      imports: [ProjectAgentsComponent],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: api },
        { provide: AuthService, useValue: auth },
        { provide: StepUpService, useValue: stepUp },
        { provide: DialogService, useValue: dialog },
        { provide: ToastService, useValue: toast },
      ],
    }).compileComponents();
  });

  it('renders connection details, tokens and pending approvals', async () => {
    const f = await render();
    expect(q(f, '[data-testid="agents-api-url"]')?.textContent).toContain(`${window.location.origin}/api`);
    expect(q(f, '[data-testid="agents-config"]')?.textContent).toContain('PLATFORM_AGENT_TOKEN');
    expect(q(f, '[data-testid="agents-docs-link"]')?.getAttribute('href')).toContain('/docs/mcp/setup');
    expect(q(f, '[data-testid="agents-scope-note"]')?.textContent).toContain('not tied to this project');

    const tokens = q(f, '[data-testid="agents-tokens-table"]')!;
    expect(tokens.textContent).toContain('laptop-cursor');
    expect(tokens.textContent).toContain('projects:read');
    expect(tokens.textContent).toContain('Active');

    const pending = q(f, '[data-testid="agents-pending-table"]')!;
    expect(pending.textContent).toContain('kubectl delete pod web-1 -n demo');
    expect(pending.textContent).toContain('laptop-cursor');
  });

  it('shows calm empty states when there are no tokens or approvals', async () => {
    api.getAgentTokens.and.returnValue(of([]));
    api.getPendingAgentCommands.and.returnValue(of([]));
    const f = await render();
    expect(q(f, '[data-testid="agents-tokens-empty"]')?.textContent).toContain('No agent tokens yet');
    expect(q(f, '[data-testid="agents-pending-empty"]')?.textContent).toContain('Nothing is waiting');
    expect(q(f, '[data-testid="agents-tokens-table"]')).toBeNull();
    expect(q(f, '[data-testid="agents-pending-table"]')).toBeNull();
  });

  it('approve calls the approve endpoint and removes the row', async () => {
    const f = await render();
    (q(f, '[data-testid="agents-approve"]') as HTMLButtonElement).click();
    await f.whenStable();
    f.detectChanges();
    expect(api.approveAgentCommand).toHaveBeenCalledWith('a1');
    expect(api.rejectAgentCommand).not.toHaveBeenCalled();
    expect(q(f, '[data-testid="agents-pending-empty"]')).not.toBeNull();
  });

  it('reject calls the reject endpoint', async () => {
    const f = await render();
    (q(f, '[data-testid="agents-reject"]') as HTMLButtonElement).click();
    await f.whenStable();
    expect(api.rejectAgentCommand).toHaveBeenCalledWith('a1');
    expect(api.approveAgentCommand).not.toHaveBeenCalled();
  });

  it('keeps the row and shows the API error when a decision fails', async () => {
    api.approveAgentCommand.and.returnValue(throwError(() => ({ error: { error: 'Approval changed state concurrently' } })));
    const f = await render();
    (q(f, '[data-testid="agents-approve"]') as HTMLButtonElement).click();
    await f.whenStable();
    f.detectChanges();
    expect(f.nativeElement.textContent).toContain('Approval changed state concurrently');
    expect(q(f, '[data-testid="agents-pending-table"]')).not.toBeNull();
  });

  it('tech leads see the queue but cannot approve, and do not load tokens', async () => {
    setRole(false, true);
    const f = await render();
    expect(api.getAgentTokens).not.toHaveBeenCalled();
    expect(q(f, '[data-testid="agents-tokens-no-access"]')).not.toBeNull();
    expect(q(f, '[data-testid="agents-pending-table"]')).not.toBeNull();
    expect(q(f, '[data-testid="agents-approve"]')).toBeNull();
  });

  it('developers call no token or approval endpoints, but see their connected assistants', async () => {
    setRole(false, false);
    const f = await render();
    expect(api.getAgentTokens).not.toHaveBeenCalled();
    expect(api.getPendingAgentCommands).not.toHaveBeenCalled();
    expect(api.getMcpConnections).toHaveBeenCalled();
    expect(q(f, '[data-testid="agents-pending-no-access"]')).not.toBeNull();
    expect(q(f, '[data-testid="agents-connections-table"]')?.textContent).toContain('Claude');
  });

  describe('Connect an AI assistant', () => {
    it('shows the connector URL from the current origin first and copies it', async () => {
      const clip = spyOn(navigator.clipboard, 'writeText').and.returnValue(Promise.resolve());
      const f = await render();
      const sections = Array.from(f.nativeElement.querySelectorAll('section')) as HTMLElement[];
      expect(sections[0].getAttribute('data-testid')).toBe('agents-assistant');
      const input = q(f, '[data-testid="agents-connector-url"]') as HTMLInputElement;
      expect(input.value).toBe(`${window.location.origin}/mcp`);
      (q(f, '[data-testid="agents-copy-connector"]') as HTMLButtonElement).click();
      await f.whenStable();
      expect(clip).toHaveBeenCalledWith(`${window.location.origin}/mcp`);
      expect(toast.ok).toHaveBeenCalledWith('Connector URL copied');
    });

    it('has a tab per assistant, with the Claude Code command filled in', async () => {
      const f = await render();
      for (const id of ['claude', 'chatgpt', 'cursor', 'vscode', 'claude-code']) {
        expect(q(f, `[data-testid="agents-tab-${id}"]`)).not.toBeNull();
      }
      expect(q(f, '[data-testid="agents-tab-claude"]')?.getAttribute('aria-selected')).toBe('true');
      expect(q(f, '[data-testid="agents-assistant-panel"]')?.textContent).toContain('Add custom connector');

      (q(f, '[data-testid="agents-tab-claude-code"]') as HTMLButtonElement).click();
      f.detectChanges();
      expect(q(f, '[data-testid="agents-assistant-snippet"]')?.textContent)
        .toContain(`claude mcp add --transport http cairn ${window.location.origin}/mcp`);

      (q(f, '[data-testid="agents-tab-vscode"]') as HTMLButtonElement).click();
      f.detectChanges();
      const vscode = JSON.parse(q(f, '[data-testid="agents-assistant-snippet"]')!.textContent!);
      expect(vscode.servers.cairn).toEqual({ type: 'http', url: `${window.location.origin}/mcp` });

      (q(f, '[data-testid="agents-tab-cursor"]') as HTMLButtonElement).click();
      f.detectChanges();
      expect(JSON.parse(q(f, '[data-testid="agents-assistant-snippet"]')!.textContent!).mcpServers.cairn.url).toBe(`${window.location.origin}/mcp`);
    });

    it('moves between tabs with the arrow keys', async () => {
      const f = await render();
      const cmp = f.componentInstance;
      const tabs = q(f, '[data-testid="agents-assistant-tabs"]')!;
      tabs.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
      expect(cmp.activeAssistant).toBe('chatgpt');
      tabs.dispatchEvent(new KeyboardEvent('keydown', { key: 'End' }));
      expect(cmp.activeAssistant).toBe('claude-code');
      tabs.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
      expect(cmp.activeAssistant).toBe('claude');
    });

    it('warns when the server has no public address', async () => {
      api.getMcpConnections.and.returnValue(of({ connectorUrl: null, configured: false, connections: [] }));
      const f = await render();
      expect(q(f, '[data-testid="agents-remote-off"]')).not.toBeNull();
      expect(q(f, '[data-testid="agents-connections-empty"]')).not.toBeNull();
    });
  });

  describe('Connected assistants', () => {
    it('lists name, scopes, approver and last use', async () => {
      const f = await render();
      const table = q(f, '[data-testid="agents-connections-table"]')!;
      expect(table.textContent).toContain('Claude');
      expect(table.textContent).toContain('logs:read');
      expect(table.textContent).toContain('You');
      expect(table.textContent).toContain('Never');
    });

    it('disconnects after a danger confirmation', async () => {
      const f = await render();
      (q(f, '[data-testid="agents-disconnect-g1"]') as HTMLButtonElement).click();
      await f.whenStable();
      f.detectChanges();
      expect(dialog.confirm).toHaveBeenCalledWith(jasmine.objectContaining({ danger: true, confirmLabel: 'Disconnect' }));
      expect(api.disconnectMcpConnection).toHaveBeenCalledWith('g1');
      expect(toast.ok).toHaveBeenCalledWith('Claude disconnected');
      expect(q(f, '[data-testid="agents-connections-empty"]')).not.toBeNull();
    });

    it('does nothing when the confirmation is cancelled', async () => {
      dialog.confirm.and.returnValue(Promise.resolve(false));
      const f = await render();
      (q(f, '[data-testid="agents-disconnect-g1"]') as HTMLButtonElement).click();
      await f.whenStable();
      expect(api.disconnectMcpConnection).not.toHaveBeenCalled();
    });

    it('shows a toast and keeps the row when disconnect fails', async () => {
      api.disconnectMcpConnection.and.returnValue(throwError(() => ({ error: { error: 'Connection not found' } })));
      const f = await render();
      (q(f, '[data-testid="agents-disconnect-g1"]') as HTMLButtonElement).click();
      await f.whenStable();
      f.detectChanges();
      expect(toast.error).toHaveBeenCalledWith('Connection not found');
      expect(q(f, '[data-testid="agents-connections-table"]')).not.toBeNull();
    });

    it('names the connected assistant on approvals it requested', async () => {
      api.getPendingAgentCommands.and.returnValue(of([{ ...APPROVAL, requestedByAgentTokenId: null, requestedByMcpGrantId: 'g1' }]));
      const f = await render();
      expect(q(f, '[data-testid="agents-pending-table"]')?.textContent).toContain('Claude');
    });

    it('shows which person the assistant acts for on its approvals', async () => {
      api.getMcpConnections.and.returnValue(of({ configured: true, connections: [] }));
      api.getPendingAgentCommands.and.returnValue(of([{
        ...APPROVAL, requestedByAgentTokenId: null, requestedByMcpGrantId: 'g9',
        metadata: { assistantName: 'ChatGPT', actingFor: { id: 'u2', name: 'Ravi' } },
      }]));
      const f = await render();
      const table = q(f, '[data-testid="agents-pending-table"]')!;
      expect(table.textContent).toContain('ChatGPT');
      expect(q(f, '[data-testid="agents-acting-for"]')?.textContent).toContain('for Ravi');
    });
  });

  it('creates a token and shows the plaintext once', async () => {
    api.createAgentToken.and.returnValue(of({ ...TOKEN, id: 't2', name: 'ci-bot', token: 'plat_agent_secretvalue' }));
    const f = await render();
    const cmp = f.componentInstance;
    cmp.openCreate();
    cmp.newToken.name = 'ci-bot';
    await cmp.createToken();
    f.detectChanges();
    expect(stepUp.run).toHaveBeenCalled();
    const body = api.createAgentToken.calls.mostRecent().args[0];
    expect(body.name).toBe('ci-bot');
    expect(body.scopes).toContain('projects:read');
    expect(body.scopes).not.toContain('replays:read');
    expect(q(f, '[data-testid="agents-created-token"]')?.textContent).toContain('plat_agent_secretvalue');
    expect(q(f, '[data-testid="agents-config"]')?.textContent).toContain('plat_agent_secretvalue');
    cmp.dismissCreatedToken();
    f.detectChanges();
    expect(f.nativeElement.textContent).not.toContain('plat_agent_secretvalue');
  });
});
