import { TestBed } from '@angular/core/testing';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { DeploymentsComponent } from './deployments.component';
import { ApiService } from '../../services/api.service';
import { of } from 'rxjs';

describe('DeploymentsComponent', () => {
  let apiService: jasmine.SpyObj<ApiService>;

  beforeEach(async () => {
    const spy = jasmine.createSpyObj('ApiService', ['getProjects', 'deploy', 'rollback', 'restartDeployment']);

    await TestBed.configureTestingModule({
      imports: [DeploymentsComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: ApiService, useValue: spy },
      ],
    }).compileComponents();

    apiService = TestBed.inject(ApiService) as jasmine.SpyObj<ApiService>;
    apiService.getProjects.and.returnValue(of([]));
  });

  it('should create', () => {
    const fixture = TestBed.createComponent(DeploymentsComponent);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('should load deployments from projects', async () => {
    apiService.getProjects.and.returnValue(of([
      {
        id: 'p1', name: 'App',
        deployments: [
          { id: 'd1', status: 'deployed' },
          { id: 'd2', status: 'pending' },
        ],
      },
    ]));

    const fixture = TestBed.createComponent(DeploymentsComponent);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(fixture.componentInstance.deployments.length).toBe(2);
  });

  it('should deploy a new version', async () => {
    const newDep = { id: 'd3', status: 'pending', projectId: 'p1', version: '1.0', branch: 'main' };
    apiService.deploy.and.returnValue(of(newDep));

    const fixture = TestBed.createComponent(DeploymentsComponent);
    fixture.componentInstance.deployDto = { projectId: 'p1', version: '1.0', branch: 'main' };

    await fixture.componentInstance.deploy();

    expect(fixture.componentInstance.deployments.length).toBe(1);
    expect(fixture.componentInstance.deployDto.projectId).toBe('');
  });

  it('should rollback a deployment', async () => {
    apiService.rollback.and.returnValue(of({}));
    spyOn(window, 'alert');

    const fixture = TestBed.createComponent(DeploymentsComponent);
    fixture.componentInstance.rollbackDto = { projectId: 'p1', deploymentId: 'd1' };

    await fixture.componentInstance.rollback();

    expect(window.alert).toHaveBeenCalledWith('Rollback initiated');
  });

  it('should restart a deployment', async () => {
    apiService.restartDeployment.and.returnValue(of({}));
    spyOn(window, 'alert');

    const fixture = TestBed.createComponent(DeploymentsComponent);
    await fixture.componentInstance.restart('d1');

    expect(window.alert).toHaveBeenCalledWith('Restart initiated');
  });
});
