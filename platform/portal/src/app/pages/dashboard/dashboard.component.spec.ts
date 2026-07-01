import { TestBed } from '@angular/core/testing';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { DashboardComponent } from './dashboard.component';
import { ApiService } from '../../services/api.service';
import { of } from 'rxjs';

describe('DashboardComponent', () => {
  let component: DashboardComponent;
  let apiService: jasmine.SpyObj<ApiService>;

  beforeEach(async () => {
    const spy = jasmine.createSpyObj('ApiService', ['getProjects', 'getBootstrapStatus']);

    await TestBed.configureTestingModule({
      imports: [DashboardComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: ApiService, useValue: spy },
      ],
    }).compileComponents();

    apiService = TestBed.inject(ApiService) as jasmine.SpyObj<ApiService>;
    apiService.getProjects.and.returnValue(of([]));
    apiService.getBootstrapStatus.and.returnValue(of({ services: {} }));
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
    fixture.detectChanges();
    await fixture.whenStable();

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
    fixture.detectChanges();
    await fixture.whenStable();

    expect(component.recentDeployments.length).toBe(2);
  });

  it('should handle API errors gracefully', async () => {
    apiService.getProjects.and.returnValue(of([]));
    apiService.getBootstrapStatus.and.returnValue(of({ services: {} }));

    const fixture = TestBed.createComponent(DashboardComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();

    expect(component.stats.projects).toBe(0);
  });

  it('should load system health from bootstrap status', async () => {
    apiService.getBootstrapStatus.and.returnValue(of({
      services: { postgres: 'running', mongo: 'running', redis: 'stopped' },
    }));

    const fixture = TestBed.createComponent(DashboardComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();

    expect(component.systemHealth.length).toBe(3);
    expect(component.stats.services).toBe(2);
  });
});
