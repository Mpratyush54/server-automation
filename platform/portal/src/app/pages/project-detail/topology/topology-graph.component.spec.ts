import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TopologyGraphComponent, TopologyResponse } from './topology-graph.component';

const PID = '11111111-1111-4111-8111-111111111111';
const ENV = '33333333-3333-4333-8333-333333333333';
const URL = `/api/projects/${PID}/environments/${ENV}/topology`;

function graph(extra: Partial<TopologyResponse> = {}): TopologyResponse {
  return {
    namespace: 'shop-staging-ns',
    appName: 'shop-staging-ns',
    environmentId: ENV,
    environment: 'staging',
    argo: { found: true, error: null, sync: 'OutOfSync', health: 'Degraded', revision: 'abc' },
    nodes: [
      { id: 'Application/shop-staging-ns', kind: 'Application', name: 'shop-staging-ns', health: 'Degraded', sync: 'OutOfSync', info: {}, events: [] },
      { id: 'Deployment/web', kind: 'Deployment', name: 'web', health: 'Progressing', sync: 'OutOfSync', info: { replicas: 2, readyReplicas: 1 }, events: [] },
      { id: 'ReplicaSet/web-1', kind: 'ReplicaSet', name: 'web-1', health: 'Progressing', sync: null, info: { replicas: 2, readyReplicas: 1 }, events: [] },
      { id: 'Pod/web-1-a', kind: 'Pod', name: 'web-1-a', health: 'Healthy', sync: null, info: { ready: '1/1' }, events: [] },
      {
        id: 'Pod/web-1-b', kind: 'Pod', name: 'web-1-b', health: 'Degraded', sync: null, info: { ready: '0/1', reason: 'CrashLoopBackOff', restarts: 4 },
        events: [{ type: 'Warning', reason: 'BackOff', message: 'Back-off restarting failed container', count: 4, lastTimestamp: '2026-11-10T11:00:00.000Z' }],
      },
    ],
    edges: [
      { from: 'Application/shop-staging-ns', to: 'Deployment/web', type: 'owns' },
      { from: 'Deployment/web', to: 'ReplicaSet/web-1', type: 'owns' },
      { from: 'ReplicaSet/web-1', to: 'Pod/web-1-a', type: 'owns' },
      { from: 'ReplicaSet/web-1', to: 'Pod/web-1-b', type: 'owns' },
    ],
    counts: { Application: 1, Deployment: 1, ReplicaSet: 1, Pod: 2 },
    warnings: [],
    generatedAt: '2026-11-10T12:00:00.000Z',
    ...extra,
  };
}

describe('TopologyGraphComponent', () => {
  let fixture: ComponentFixture<TopologyGraphComponent>;
  let comp: TopologyGraphComponent;
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TopologyGraphComponent],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(TopologyGraphComponent);
    comp = fixture.componentInstance;
    comp.refreshMs = 60_000;
  });

  afterEach(() => {
    fixture.destroy();
    http.verify();
  });

  function init(envs = [{ id: ENV, name: 'staging' }]) {
    fixture.componentRef.setInput('projectId', PID);
    fixture.componentRef.setInput('environments', envs);
    fixture.detectChanges();
  }

  // Not whenStable(): the pending poll timer keeps the zone busy by design.
  async function settle() {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();
  }
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const el = () => fixture.nativeElement as HTMLElement;

  it('shows a loading state, then renders nodes with degraded and OutOfSync markers', async () => {
    init();
    expect(el().querySelector('[data-test="loading"]')).toBeTruthy();
    http.expectOne(URL).flush(graph());
    await settle();
    const nodes = el().querySelectorAll('g.node');
    expect(nodes.length).toBe(5);
    expect(el().querySelectorAll('path.edge').length).toBe(4);
    const degraded = el().querySelector('g[data-node-id="Pod/web-1-b"]')!;
    expect(degraded.classList).toContain('h-degraded');
    const oos = el().querySelector('g[data-node-id="Deployment/web"]')!;
    expect(oos.classList).toContain('oos');
    expect(oos.textContent).toContain('OutOfSync');
    expect(el().querySelector('[data-test="summary"]')!.textContent).toContain('2 Pod');
    expect(el().querySelector('[data-test="summary"]')!.textContent).toContain('2 degraded');
  });

  it('opens the drawer with events and emits a logs request for pods', async () => {
    init();
    http.expectOne(URL).flush(graph());
    await settle();
    const emitted: any[] = [];
    comp.podLogs.subscribe((e) => emitted.push(e));
    (el().querySelector('g[data-node-id="Pod/web-1-b"]') as any).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fixture.detectChanges();
    const drawer = el().querySelector('[data-test="drawer"]')!;
    expect(drawer.textContent).toContain('web-1-b');
    expect(drawer.textContent).toContain('BackOff');
    expect(drawer.textContent).toContain('CrashLoopBackOff');
    (drawer.querySelector('[data-test="logs"]') as HTMLButtonElement).click();
    expect(emitted).toEqual([{ name: 'web-1-b', namespace: 'shop-staging-ns' }]);
    comp.onEscape();
    fixture.detectChanges();
    expect(el().querySelector('[data-test="drawer"]')).toBeNull();
  });

  it('shows the empty state and the missing-Argo banner', async () => {
    init();
    http.expectOne(URL).flush(graph({ nodes: [], edges: [], counts: {}, argo: { found: false, error: 'not found', sync: null, health: null, revision: null } }));
    await settle();
    expect(el().querySelector('[data-test="empty"]')).toBeTruthy();
    expect(el().querySelector('[data-test="argo-missing"]')!.textContent).toContain('not found');
  });

  it('shows the error state with the API message, and keeps last good data on later failures', async () => {
    init();
    http.expectOne(URL).flush({ error: 'Kubernetes unavailable' }, { status: 503, statusText: 'Unavailable' });
    await settle();
    expect(el().querySelector('[data-test="error"]')!.textContent).toContain('Kubernetes unavailable');

    comp.refresh();
    http.expectOne(URL).flush(graph());
    await settle();
    comp.refresh();
    http.expectOne(URL).flush({ error: 'boom' }, { status: 500, statusText: 'err' });
    await settle();
    expect(el().querySelectorAll('g.node').length).toBe(5);
    expect(el().querySelector('[data-test="stale"]')!.textContent).toContain('boom');
  });

  it('shows a no-environment state without calling the API', () => {
    init([]);
    expect(el().querySelector('[data-test="no-env"]')).toBeTruthy();
    http.expectNone(() => true);
  });

  it('polls only while the document is visible', async () => {
    comp.refreshMs = 200;
    init();
    http.expectOne(URL).flush(graph());
    await settle();
    await wait(300);
    http.expectOne(URL).flush(graph());
    await settle();

    const vis = spyOnProperty(document, 'visibilityState', 'get').and.returnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await wait(400);
    expect(http.match(URL)).toEqual([]);

    comp.refreshMs = 60_000;
    vis.and.returnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    http.expectOne(URL).flush(graph());
    await settle();
  });

  it('stops polling when destroyed', async () => {
    comp.refreshMs = 200;
    init();
    http.expectOne(URL).flush(graph());
    await settle();
    fixture.destroy();
    await wait(400);
    expect(http.match(URL)).toEqual([]);
  });

  it('zooms around a point and fits the graph into the viewport', async () => {
    init();
    http.expectOne(URL).flush(graph());
    await settle();
    comp.scale = 1; comp.tx = 0; comp.ty = 0;
    comp.zoomBy(2, 100, 100);
    expect(comp.scale).toBe(2);
    expect(comp.tx).toBe(-100);
    comp.fit();
    expect(comp.scale).toBeGreaterThan(0);
    expect(comp.scale).toBeLessThanOrEqual(1.2);
  });

  it('defaults to the development environment, like the Argo panel', async () => {
    const DEV = '44444444-4444-4444-8444-444444444444';
    init([{ id: ENV, name: 'staging' }, { id: DEV, name: 'development' }]);
    http.expectOne(`/api/projects/${PID}/environments/${DEV}/topology`).flush(graph());
    await settle();
    expect(comp.envId).toBe(DEV);
  });

  it('shows "not deployed yet" instead of Argo/403 banners for a never-deployed environment', async () => {
    init();
    http.expectOne(URL).flush(graph({ nodes: [], edges: [], notDeployed: true, warnings: [], argo: { found: false, error: null } as any }));
    await settle();
    expect(el().querySelector('[data-test="not-deployed"]')).toBeTruthy();
    expect(el().querySelector('[data-test="argo-missing"]')).toBeNull();
    expect(el().querySelector('[data-test="warnings"]')).toBeNull();
  });
});
