import { TestBed } from '@angular/core/testing';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { DashboardComponent } from './dashboard.component';
import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { of, throwError } from 'rxjs';

describe('DashboardComponent', () => {
  let component: DashboardComponent;
  let apiService: jasmine.SpyObj<ApiService>;

  beforeEach(async () => {
    const spy = jasmine.createSpyObj('ApiService', ['getProjects', 'getBootstrapStatus', 'getPlatformVersion', 'getPods', 'getMetrics', 'getAggregatedMetrics']);

    await TestBed.configureTestingModule({
      imports: [DashboardComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: ApiService, useValue: spy },
        { provide: AuthService, useValue: { isDevOps: () => true, isAdmin: () => false } },
      ],
    }).compileComponents();

    apiService = TestBed.inject(ApiService) as jasmine.SpyObj<ApiService>;
    apiService.getProjects.and.returnValue(of([]));
    apiService.getBootstrapStatus.and.returnValue(of({ services: {} }));
    apiService.getPlatformVersion.and.returnValue(of({}));
    apiService.getPods.and.returnValue(of({ k8sConnected: true, pods: [] }));
    apiService.getMetrics.and.returnValue(of([]));
    apiService.getAggregatedMetrics.and.returnValue(of({}));
  });

  it('should create', () => {
    const fixture = TestBed.createComponent(DashboardComponent);
    component = fixture.componentInstance;
    expect(component).toBeTruthy();
  });

  it('should load projects on init', async () => {
    apiService.getProjects.and.returnValue(of([
      { id: 'p1', name: 'Project 1', deployments: [] },
      { id: 'p2', name: 'Project 2', deployments: [] },
    ]));

    const fixture = TestBed.createComponent(DashboardComponent);
    component = fixture.componentInstance;
    // ngOnInit starts a telemetry setInterval, so the zone never becomes stable;
    // await init directly and destroy the fixture to clear the timer.
    await component.ngOnInit();
    fixture.destroy();

    expect(component.stats.projects).toBe(2);
  });

  it('should compute recent deployments from projects', async () => {
    apiService.getProjects.and.returnValue(of([
      {
        id: 'p1', name: 'Project 1',
        deployments: [
          { id: 'd1', status: 'active', createdAt: '2024-01-01' },
          { id: 'd2', status: 'deployed', createdAt: '2024-01-02' },
        ],
      },
    ]));

    const fixture = TestBed.createComponent(DashboardComponent);
    component = fixture.componentInstance;
    // ngOnInit starts a telemetry setInterval, so the zone never becomes stable;
    // await init directly and destroy the fixture to clear the timer.
    await component.ngOnInit();
    fixture.destroy();

    expect(component.recentDeployments.length).toBe(2);
  });

  it('should handle API errors gracefully', async () => {
    apiService.getProjects.and.returnValue(throwError(() => new Error('unavailable')));
    apiService.getBootstrapStatus.and.returnValue(of({ services: {} }));

    const fixture = TestBed.createComponent(DashboardComponent);
    component = fixture.componentInstance;
    // ngOnInit starts a telemetry setInterval, so the zone never becomes stable;
    // await init directly and destroy the fixture to clear the timer.
    await component.ngOnInit();
    fixture.destroy();

    expect(component.stats.projects).toBeNull();
    expect(component.stats.deployments).toBeNull();
    expect(component.projectTrend).toBeNull();
    expect(component.avgDeployTime).toBe('—');
  });

  it('should load system health from bootstrap status', async () => {
    apiService.getBootstrapStatus.and.returnValue(of({
      services: { postgres: 'running', mongo: 'running', redis: 'stopped' },
    }));

    const fixture = TestBed.createComponent(DashboardComponent);
    component = fixture.componentInstance;
    // ngOnInit starts a telemetry setInterval, so the zone never becomes stable;
    // await init directly and destroy the fixture to clear the timer.
    await component.ngOnInit();
    fixture.destroy();

    expect(component.systemHealth.length).toBe(3);
    expect(component.stats.services).toBe(2);
  });

  it('renders the install identity and honest empty state', async () => {
    apiService.getBootstrapStatus.and.returnValue(of({ platformName: 'install.example.test', services: {} }));
    const fixture = TestBed.createComponent(DashboardComponent);
    component = fixture.componentInstance;
    await component.ngOnInit();
    spyOn(component, 'ngOnInit').and.stub();
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('install.example.test');
    expect(text).not.toContain('vs last week');
    expect(text).toContain('— avg deploy time');
    expect(text).not.toContain('Prod-Kengeri');
    expect(component.stats.namespaces).toBe(0);
    fixture.destroy();
  });

  it('uses all deployments for totals and average, independently of the ten recent rows', async () => {
    const deployments = Array.from({ length: 12 }, (_, i) => ({
      id: `d${i}`, status: 'deployed', createdAt: '2026-11-01T00:00:00Z',
      deployedAt: i === 11 ? '2026-11-01T00:03:00Z' : '2026-11-01T00:01:00Z',
    }));
    apiService.getProjects.and.returnValue(of([{ id: 'p1', name: 'app', deployments }]));
    const fixture = TestBed.createComponent(DashboardComponent);
    component = fixture.componentInstance;
    await component.ngOnInit();
    expect(component.recentDeployments.length).toBe(10);
    expect(component.stats.deployments).toBe(12);
    expect(component.avgDeployTime).toBe('1m 10s');
    fixture.destroy();
  });

  it('does not count fallback pods when Kubernetes is disconnected', async () => {
    apiService.getProjects.and.returnValue(of([{ id: 'p1', name: 'app', environments: [{ namespace: 'app' }] }]));
    apiService.getPods.and.returnValue(of({ k8sConnected: false, pods: [{ namespace: 'app', name: 'app', status: 'Running' }] }));
    const fixture = TestBed.createComponent(DashboardComponent);
    component = fixture.componentInstance;
    await component.ngOnInit();
    expect(component.stats.podsText).toBe('—');
    expect(component.platformName).toBe('');
    fixture.destroy();
  });
});
