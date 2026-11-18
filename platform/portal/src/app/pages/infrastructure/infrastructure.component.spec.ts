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
  it("colours the Running dependency cards green, matching the status", async () => {
    const fixture = TestBed.createComponent(InfrastructureComponent);
    await fixture.componentInstance.refreshAllData();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    for (const id of ["status-postgres", "status-mongodb"]) {
      const dot = el.querySelector(`[data-testid="${id}"]`) as HTMLElement;
      expect(dot.textContent?.trim()).toBe("Running");
      expect(dot.classList).toContain("status-ok");
      expect(dot.classList).not.toContain("status-down");
    }
    const cmp = fixture.componentInstance;
    expect(cmp.serviceStatusClass("degraded")).toBe("status-warn");
    expect(cmp.serviceStatusClass("offline")).toBe("status-down");
    expect(cmp.serviceStatusClass("unknown")).toBe("");
  });

  it("keeps the last servers while one poll fails, then reports the outage after repeated failures", async () => {
    const nodes = [{ name: "srv-1", ip: "10.0.0.1", role: "master", status: "Ready", cpu: "2 Core", memory: "4Gi" },
      { name: "srv-2", ip: "10.0.0.2", role: "master", status: "NotReady", cpu: "2 Core", memory: "4Gi" }];
    api.getNodes.and.returnValue(of({ k8sConnected: true, nodes }));
    const fixture = TestBed.createComponent(InfrastructureComponent);
    const cmp = fixture.componentInstance;
    await cmp.refreshAllData();
    expect(cmp.k8sConnected).toBe(true);

    // One server died and the API request landed on it.
    api.getNodes.and.returnValue(of({ k8sConnected: false, nodes: [] }));
    api.getPods.and.returnValue(throwError(() => new Error("timeout")));
    await cmp.refreshAllData();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(cmp.nodes.length).toBe(2);
    expect(cmp.k8sConnected).toBe(true);
    expect(cmp.clusterReconnecting).toBe(true);
    expect(el.querySelector("[data-testid=\"cluster-reconnecting\"]")).toBeTruthy();
    expect(el.querySelector("[data-testid=\"cluster-down\"]")).toBeNull();
    expect(el.querySelector("[data-testid=\"status-cluster\"]")?.textContent).toContain("Reconnecting");
    expect(el.textContent).toContain("srv-1");

    await cmp.refreshAllData();
    await cmp.refreshAllData();
    fixture.detectChanges();
    expect(cmp.k8sConnected).toBe(false);
    expect(cmp.nodes.length).toBe(2);
    expect(el.querySelector("[data-testid=\"cluster-down\"]")?.textContent).toContain("Showing the last data");

    api.getNodes.and.returnValue(of({ k8sConnected: true, nodes: nodes.slice(0, 1) }));
    await cmp.refreshAllData();
    expect(cmp.k8sConnected).toBe(true);
    expect(cmp.clusterReconnecting).toBe(false);
    expect(cmp.nodes.length).toBe(1);
  });

  it("does not show another namespace's pods after a failed filtered load", async () => {
    api.getPods.and.returnValue(of({ k8sConnected: true, pods: [{ name: "p", namespace: "a", status: "Running" }] }));
    const fixture = TestBed.createComponent(InfrastructureComponent);
    const cmp = fixture.componentInstance;
    await cmp.loadPods();
    expect(cmp.pods.length).toBe(1);
    api.getPods.and.returnValue(throwError(() => new Error("timeout")));
    cmp.selectedNamespace = "b";
    await cmp.loadPods();
    expect(cmp.pods).toEqual([]);
  });
});
