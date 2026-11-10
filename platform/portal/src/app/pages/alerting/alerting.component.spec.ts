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
});
