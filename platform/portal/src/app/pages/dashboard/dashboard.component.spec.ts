import { TestBed } from '@angular/core/testing';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { DashboardComponent } from './dashboard.component';
import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { AlertingApiService } from '../alerting/alerting-api.service';
import { of, throwError } from 'rxjs';

describe('DashboardComponent', () => {
  let api: jasmine.SpyObj<ApiService>;
  let alerting: jasmine.SpyObj<AlertingApiService>;
  let role = { devops: true, admin: false, users: false };

  const recent = (min: number) => new Date(Date.now() - min * 60000).toISOString();

  beforeEach(async () => {
    role = { devops: true, admin: false, users: false };
    api = jasmine.createSpyObj('ApiService', ['getProjects', 'getBootstrapStatus', 'getPlatformVersion', 'getNodes', 'getBackupStatus', 'getMe', 'getUsers']);
    alerting = jasmine.createSpyObj('AlertingApiService', ['allIncidents']);
    await TestBed.configureTestingModule({
      imports: [DashboardComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: ApiService, useValue: api },
        { provide: AlertingApiService, useValue: alerting },
        {
          provide: AuthService,
          useValue: {
            getUser: () => ({ name: 'Asha Rao' }),
            isDevOps: () => role.devops,
            isAdmin: () => role.admin,
            canManageUsers: () => role.users,
          },
        },
      ],
    }).compileComponents();
    api.getProjects.and.returnValue(of([]));
    api.getBootstrapStatus.and.returnValue(of({ services: {} }));
    api.getPlatformVersion.and.returnValue(of({}));
    api.getNodes.and.returnValue(of({ k8sConnected: true, nodes: [{ name: 'node-1', status: 'Ready' }] }));
    api.getBackupStatus.and.returnValue(of({ items: [{ operation: 'backup', status: { success: true, finishedAt: recent(60) } }] }));
    api.getMe.and.returnValue(of({}));
    api.getUsers.and.returnValue(of([]));
    alerting.allIncidents.and.returnValue(of([]));
  });

  async function render() {
    const fixture = TestBed.createComponent(DashboardComponent);
    // ngOnInit starts a refresh interval; run init directly, render, then destroy.
    await fixture.componentInstance.ngOnInit();
    spyOn(fixture.componentInstance, 'ngOnInit').and.stub();
    fixture.detectChanges();
    return fixture;
  }

  it('greets the user and says when everything is running', async () => {
    api.getProjects.and.returnValue(of([{ id: 'p1', name: 'shop', environments: [{ id: 'e1', name: 'production' }],
      deployments: [{ id: 'd1', status: 'deployed', environmentId: 'e1', createdAt: recent(5), version: 'v1' }] }]));
    const f = await render();
    const text = f.nativeElement.textContent;
    expect(text).toContain('Asha');
    expect(text).toContain('Everything is running');
    expect(text).toContain('1 of 1 server ready');
    f.destroy();
  });

  it('lists what needs attention, most serious first', async () => {
    api.getProjects.and.returnValue(of([{ id: 'p1', name: 'billing', environments: [{ id: 'e1', name: 'production' }],
      deployments: [{ id: 'd1', status: 'failed', environmentId: 'e1', createdAt: recent(5) }] }]));
    alerting.allIncidents.and.returnValue(of([{ id: 'i1', projectId: 'p1', status: 'firing', severity: 'warning', title: 'Slow checkout', firstSeenAt: recent(3) }]));
    const f = await render();
    const items = Array.from(f.nativeElement.querySelectorAll('.db-attention li')).map((li: any) => li.textContent);
    expect(items.length).toBe(2);
    expect(items[0]).toContain('billing: the last production deployment failed');
    expect(items[1]).toContain('Slow checkout');
    f.destroy();
  });

  it('shows the platform name when the install has one', async () => {
    api.getBootstrapStatus.and.returnValue(of({ platformName: 'install.example.test', services: {} }));
    const f = await render();
    expect(f.nativeElement.textContent).toContain('install.example.test');
    f.destroy();
  });

  it('does not show servers when the cluster is unreachable, and says so', async () => {
    api.getNodes.and.returnValue(of({ k8sConnected: false, nodes: [{ name: 'fake', status: 'Ready' }] }));
    const f = await render();
    expect(f.componentInstance.nodes.length).toBe(0);
    expect(f.nativeElement.textContent).toContain('cannot reach the cluster');
    f.destroy();
  });

  it('skips server and backup data for roles that cannot read them', async () => {
    role = { devops: false, admin: false, users: false };
    const f = await render();
    expect(api.getNodes).not.toHaveBeenCalled();
    expect(api.getBackupStatus).not.toHaveBeenCalled();
    expect(f.nativeElement.querySelector('#db-platform')).toBeNull();
    f.destroy();
  });

  it('keeps working when sources fail', async () => {
    api.getProjects.and.returnValue(throwError(() => new Error('down')));
    alerting.allIncidents.and.returnValue(throwError(() => new Error('down')));
    api.getNodes.and.returnValue(throwError(() => new Error('down')));
    const f = await render();
    expect(f.componentInstance.loaded).toBeTrue();
    expect(f.nativeElement.textContent).toContain('No apps yet');
    f.destroy();
  });

  it('shows the setup checklist on a new install and can hide it', async () => {
    try { localStorage.removeItem('platform.dashboard.setupHidden'); } catch {}
    const f = await render();
    expect(f.nativeElement.textContent).toContain('Get set up');
    f.componentInstance.hideChecklist();
    f.detectChanges();
    expect(f.nativeElement.textContent).not.toContain('Get set up');
    try { localStorage.removeItem('platform.dashboard.setupHidden'); } catch {}
    f.destroy();
  });
});
