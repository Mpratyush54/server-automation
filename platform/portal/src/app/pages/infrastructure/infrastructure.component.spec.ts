import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { InfrastructureComponent } from './infrastructure.component';
import { ApiService } from '../../services/api.service';
import { ToastService, DialogService } from '../../shared/feedback/feedback.service';

describe('InfrastructureComponent metrics', () => {
  let api: jasmine.SpyObj<ApiService>;

  beforeEach(async () => {
    api = jasmine.createSpyObj('ApiService', [
      'getBootstrapStatus',
      'getNodes',
      'getNamespaces',
      'getPods',
      'getBootstrapHistory',
      'getNodeMetrics',
      'getPodLogs',
      'deletePod',
    ]);
    api.getBootstrapStatus.and.returnValue(of({ postgres: 'running', mongodb: 'running', k8s: 'connected' }));
    api.getNodes.and.returnValue(of({ k8sConnected: true, nodes: [] }));
    api.getNamespaces.and.returnValue(of({ namespaces: [] }));
    api.getPods.and.returnValue(of({ k8sConnected: true, pods: [] }));
    api.getBootstrapHistory.and.returnValue(of([]));
    api.getNodeMetrics.and.returnValue(of({
      k8sConnected: true,
      metricsAvailable: true,
      nodes: [{
        name: 'node-a',
        cpuUsedCores: 0.5,
        cpuCapacityCores: 4,
        memoryUsedBytes: 1024 ** 3,
        memoryCapacityBytes: 8 * 1024 ** 3,
      }],
    }));

    await TestBed.configureTestingModule({
      imports: [InfrastructureComponent],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: api },
        { provide: ToastService, useValue: jasmine.createSpyObj('ToastService', ['ok', 'error']) },
        { provide: DialogService, useValue: jasmine.createSpyObj('DialogService', ['confirm']) },
      ],
    }).compileComponents();
  });

  it('loads real node metrics when the Metrics tab is selected', async () => {
    const fixture = TestBed.createComponent(InfrastructureComponent);
    const cmp = fixture.componentInstance;
    await cmp.ngOnInit();
    cmp.selectTab('metrics');
    await fixture.whenStable();

    expect(api.getNodeMetrics).toHaveBeenCalled();
    expect(cmp.metricsAvailable).toBe(true);
    expect(cmp.nodeMetrics.length).toBe(1);
    expect(cmp.cpuPct(cmp.nodeMetrics[0])).toBeCloseTo(12.5);
    expect(cmp.memoryPct(cmp.nodeMetrics[0])).toBeCloseTo(12.5);

    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent || '';
    expect(text).toContain('node-a');
    expect(text).not.toContain('simulated');
    expect(text).not.toMatch(/Math\.random/);
  });

  it('shows a Grafana link when metrics are unavailable', async () => {
    api.getNodeMetrics.and.returnValue(of({ k8sConnected: true, metricsAvailable: false, nodes: [] }));
    const fixture = TestBed.createComponent(InfrastructureComponent);
    const cmp = fixture.componentInstance;
    await cmp.ngOnInit();
    cmp.selectTab('metrics');
    await fixture.whenStable();
    fixture.detectChanges();

    expect(cmp.metricsAvailable).toBe(false);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Node metrics are unavailable');
    const link = el.querySelector('a[href="/grafana"]') as HTMLAnchorElement | null;
    expect(link).toBeTruthy();
  });

  it('clears metrics on API error without inventing values', async () => {
    api.getNodeMetrics.and.returnValue(throwError(() => new Error('down')));
    const fixture = TestBed.createComponent(InfrastructureComponent);
    const cmp = fixture.componentInstance;
    await cmp.loadNodeMetrics();
    expect(cmp.metricsAvailable).toBe(false);
    expect(cmp.nodeMetrics).toEqual([]);
  });

  it('stops metrics polling when leaving the tab', async () => {
    const fixture = TestBed.createComponent(InfrastructureComponent);
    const cmp = fixture.componentInstance;
    await cmp.ngOnInit();
    cmp.selectTab('metrics');
    expect((cmp as any).metricsInterval).toBeTruthy();
    cmp.selectTab('nodes');
    expect((cmp as any).metricsInterval).toBeUndefined();
  });
});
