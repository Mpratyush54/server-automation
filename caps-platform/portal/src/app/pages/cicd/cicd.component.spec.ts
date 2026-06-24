import { TestBed } from '@angular/core/testing';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { CicdComponent } from './cicd.component';
import { ApiService } from '../../services/api.service';
import { of } from 'rxjs';

describe('CicdComponent', () => {
  let apiService: jasmine.SpyObj<ApiService>;

  beforeEach(async () => {
    const spy = jasmine.createSpyObj('ApiService', ['getDockerfile', 'getGitlabCiYml', 'getHelmChart', 'getK8sManifests']);

    await TestBed.configureTestingModule({
      imports: [CicdComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: ApiService, useValue: spy },
      ],
    }).compileComponents();

    apiService = TestBed.inject(ApiService) as jasmine.SpyObj<ApiService>;
  });

  it('should create', () => {
    const fixture = TestBed.createComponent(CicdComponent);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('should load dockerfile', async () => {
    apiService.getDockerfile.and.returnValue(of({ dockerfile: 'FROM node:20' }));

    const fixture = TestBed.createComponent(CicdComponent);
    fixture.componentInstance.stack = 'nodejs';

    await fixture.componentInstance.loadDockerfile();

    expect(fixture.componentInstance.dockerfile).toBe('FROM node:20');
    expect(fixture.componentInstance.loading).toBeFalse();
  });

  it('should load gitlab CI', async () => {
    apiService.getGitlabCiYml.and.returnValue(of({ yaml: 'stages:\n  - build' }));

    const fixture = TestBed.createComponent(CicdComponent);
    fixture.componentInstance.projectName = 'test';
    fixture.componentInstance.stack = 'nodejs';

    await fixture.componentInstance.loadGitlabCi();

    expect(fixture.componentInstance.gitlabCi).toBe('stages:\n  - build');
  });

  it('should load helm chart', async () => {
    apiService.getHelmChart.and.returnValue(of({ chart: { name: 'test-chart' } }));

    const fixture = TestBed.createComponent(CicdComponent);
    await fixture.componentInstance.loadHelm();

    expect(fixture.componentInstance.helm).toEqual({ chart: { name: 'test-chart' } });
  });

  it('should load k8s manifests', async () => {
    apiService.getK8sManifests.and.returnValue(of({ kind: 'Deployment' }));

    const fixture = TestBed.createComponent(CicdComponent);
    await fixture.componentInstance.loadK8s();

    expect(fixture.componentInstance.k8s).toEqual({ kind: 'Deployment' });
  });
});
