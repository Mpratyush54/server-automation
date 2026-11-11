import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { AlertingComponent } from './alerting.component';
import { AlertingApiService } from './alerting-api.service';
import { ApiService } from '../../services/api.service';

describe('AlertingComponent', () => {
  let alerting: jasmine.SpyObj<AlertingApiService>;

  beforeEach(async () => {
    alerting = jasmine.createSpyObj('AlertingApiService', ['status', 'allIncidents', 'list', 'create', 'update', 'remove', 'ack', 'resolve', 'testChannel', 'sloStatus', 'testEvent']);
    alerting.status.and.returnValue(of({ mode: 'api' }));
    alerting.allIncidents.and.returnValue(of([{ id: 'i1', projectId: 'p1', status: 'firing', severity: 'critical', title: 'High errors', source: 'monitor', eventCount: 2, firstSeenAt: new Date().toISOString() }]));
    alerting.list.and.returnValue(of([]));
    alerting.ack.and.returnValue(of({}));
    const api = jasmine.createSpyObj('ApiService', ['getProjects']);
    api.getProjects.and.returnValue(of([{ id: 'p1', name: 'shop' }]));
    await TestBed.configureTestingModule({
      imports: [AlertingComponent],
      providers: [provideRouter([]), { provide: AlertingApiService, useValue: alerting }, { provide: ApiService, useValue: api }],
    }).compileComponents();
  });

  it('lists open incidents across projects and acknowledges one', async () => {
    const fixture = TestBed.createComponent(AlertingComponent);
    await fixture.componentInstance.ngOnInit();
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('High errors');
    expect(text).toContain('shop');
    await fixture.componentInstance.ack(fixture.componentInstance.incidents[0]);
    expect(alerting.ack).toHaveBeenCalledWith('p1', 'i1');
  });

  it('shows error budget remaining for SLOs', () => {
    const c = TestBed.createComponent(AlertingComponent).componentInstance;
    expect(c.budgetPercent({ status: { errorBudgetRemaining: 0.42 } })).toBeCloseTo(42);
    expect(c.budgetPercent({ status: null })).toBeNull();
  });

  it('sends channel secrets only in the secrets object', async () => {
    const fixture = TestBed.createComponent(AlertingComponent);
    const c = fixture.componentInstance;
    c.projectId = 'p1';
    alerting.create.and.returnValue(of({ id: 'c1' }));
    c.newChannel = { type: 'slack', name: 'ops', minSeverity: 'warning', fields: { webhookUrl: 'https://hooks.example.test/x', channel: '' } };
    await c.createChannel();
    expect(alerting.create).toHaveBeenCalledWith('p1', 'channels', { name: 'ops', type: 'slack', minSeverity: 'warning', secrets: { webhookUrl: 'https://hooks.example.test/x' }, config: {} });
  });

  it('links incident titles only to internal paths', async () => {
    alerting.allIncidents.and.returnValue(of([
      { id: 'i1', projectId: 'p1', status: 'firing', severity: 'critical', title: 'Synthetic failing', url: '/projects/p1/synthetics?check=c1', source: 'synthetics', eventCount: 1, firstSeenAt: new Date().toISOString() },
      { id: 'i2', projectId: 'p1', status: 'firing', severity: 'warning', title: 'External', url: 'https://evil.test/x', source: 'monitor', eventCount: 1, firstSeenAt: new Date().toISOString() },
      { id: 'i3', projectId: 'p1', status: 'firing', severity: 'warning', title: 'Script', url: 'javascript:alert(1)', source: 'monitor', eventCount: 1, firstSeenAt: new Date().toISOString() },
    ]));
    const fixture = TestBed.createComponent(AlertingComponent);
    await fixture.componentInstance.ngOnInit();
    fixture.detectChanges();
    const links = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('a[data-testid="incident-link"]')) as HTMLAnchorElement[];
    expect(links.length).toBe(1);
    expect(links[0].textContent?.trim()).toBe('Synthetic failing');
    expect(links[0].getAttribute('href')).toBe('/projects/p1/synthetics?check=c1');
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('External');
    expect(text).toContain('Script');
    expect((fixture.nativeElement as HTMLElement).querySelector('a[href^="javascript"], a[href^="https://evil"]')).toBeNull();
  });

  it('shows empty-state rows for policies and schedules', async () => {
    const fixture = TestBed.createComponent(AlertingComponent);
    const c = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
    c.projectId = 'p1';
    c.tab = 'oncall';
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="policies-empty"]')?.textContent).toContain('No escalation policies');
    expect(el.querySelector('[data-testid="schedules-empty"]')?.textContent).toContain('No on-call schedules');
  });

  it('wraps every table in a horizontal scroll container', async () => {
    const fixture = TestBed.createComponent(AlertingComponent);
    await fixture.componentInstance.ngOnInit();
    fixture.detectChanges();
    const tables = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('table'));
    expect(tables.length).toBeGreaterThan(0);
    for (const t of tables) expect(t.parentElement?.classList).toContain('table-scroll');
  });
});
