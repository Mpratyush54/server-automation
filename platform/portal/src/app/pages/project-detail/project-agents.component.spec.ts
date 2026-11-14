import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { ProjectAgentsComponent } from './project-agents.component';
import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { StepUpService } from '../../services/step-up.service';

const TOKEN = {
  id: 't1', name: 'laptop-cursor', tokenPrefix: 'plat_agent_ab12', scopes: ['projects:read', 'logs:read'],
  lastUsedAt: '2026-11-10T10:00:00.000Z', expiresAt: null, revokedAt: null, isActive: true, createdAt: '2026-11-01T10:00:00.000Z',
};
const APPROVAL = {
  id: 'a1', command: 'kubectl delete pod web-1 -n demo', riskLevel: 'destructive', status: 'pending',
  requestedByAgentTokenId: 't1', requestedByUserId: null, approvalExpiresAt: '2026-11-15T11:00:00.000Z', createdAt: '2026-11-15T10:00:00.000Z',
};

describe('ProjectAgentsComponent', () => {
  let api: jasmine.SpyObj<ApiService>;
  let auth: jasmine.SpyObj<AuthService>;
  let stepUp: jasmine.SpyObj<StepUpService>;

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
    ]);
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

  it('developers call no agent endpoints', async () => {
    setRole(false, false);
    const f = await render();
    expect(api.getAgentTokens).not.toHaveBeenCalled();
    expect(api.getPendingAgentCommands).not.toHaveBeenCalled();
    expect(q(f, '[data-testid="agents-pending-no-access"]')).not.toBeNull();
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
