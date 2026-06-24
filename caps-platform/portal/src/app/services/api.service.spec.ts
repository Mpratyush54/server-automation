import { TestBed } from '@angular/core/testing';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { ApiService } from './api.service';

describe('ApiService', () => {
  let service: ApiService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        ApiService,
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    service = TestBed.inject(ApiService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  describe('Projects', () => {
    it('should get projects', () => {
      service.getProjects().subscribe();
      const req = httpMock.expectOne('/api/projects');
      expect(req.request.method).toBe('GET');
      req.flush([]);
    });

    it('should get project by id', () => {
      service.getProject('p1').subscribe();
      const req = httpMock.expectOne('/api/projects/p1');
      expect(req.request.method).toBe('GET');
      req.flush({});
    });

    it('should create project', () => {
      const data = { name: 'test', stack: 'nodejs' };
      service.createProject(data).subscribe();
      const req = httpMock.expectOne('/api/projects');
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual(data);
      req.flush({});
    });

    it('should update project', () => {
      service.updateProject('p1', { name: 'updated' }).subscribe();
      const req = httpMock.expectOne('/api/projects/p1');
      expect(req.request.method).toBe('PUT');
      req.flush({});
    });

    it('should delete project', () => {
      service.deleteProject('p1').subscribe();
      const req = httpMock.expectOne('/api/projects/p1');
      expect(req.request.method).toBe('DELETE');
      req.flush({});
    });
  });

  describe('Deployments', () => {
    it('should deploy', () => {
      service.deploy({ projectId: 'p1', version: '1.0', branch: 'main' }).subscribe();
      const req = httpMock.expectOne('/api/deploy');
      expect(req.request.method).toBe('POST');
      req.flush({});
    });

    it('should rollback', () => {
      service.rollback({ deploymentId: 'd1' }).subscribe();
      const req = httpMock.expectOne('/api/rollback');
      expect(req.request.method).toBe('POST');
      req.flush({});
    });

    it('should restart deployment', () => {
      service.restartDeployment('d1').subscribe();
      const req = httpMock.expectOne('/api/deployments/d1/restart');
      expect(req.request.method).toBe('POST');
      req.flush({});
    });

    it('should terminate deployment', () => {
      service.terminateDeployment('d1').subscribe();
      const req = httpMock.expectOne('/api/deployments/d1/terminate');
      expect(req.request.method).toBe('POST');
      req.flush({});
    });

    it('should get project deployments', () => {
      service.getProjectDeployments('p1').subscribe();
      const req = httpMock.expectOne('/api/deployments/p1');
      expect(req.request.method).toBe('GET');
      req.flush([]);
    });
  });

  describe('SDK', () => {
    it('should register service', () => {
      service.registerService({ serviceName: 'svc' }).subscribe();
      const req = httpMock.expectOne('/api/sdk/register');
      expect(req.request.method).toBe('POST');
      req.flush({});
    });

    it('should send heartbeat', () => {
      service.sendHeartbeat({ projectId: 'p1' }).subscribe();
      const req = httpMock.expectOne('/api/sdk/heartbeat');
      expect(req.request.method).toBe('POST');
      req.flush({});
    });

    it('should get SDK config', () => {
      service.getSdkConfig('p1', 'env1').subscribe();
      const req = httpMock.expectOne(r => r.url === '/api/sdk/config');
      expect(req.request.params.get('projectId')).toBe('p1');
      expect(req.request.params.get('environmentId')).toBe('env1');
      req.flush({});
    });
  });

  describe('Alerts', () => {
    it('should get alerts', () => {
      service.getAlerts().subscribe();
      const req = httpMock.expectOne('/api/alerts');
      expect(req.request.method).toBe('GET');
      req.flush([]);
    });

    it('should create alert', () => {
      service.createAlert({ projectId: 'p1', metric: 'cpu' }).subscribe();
      const req = httpMock.expectOne('/api/alerts');
      expect(req.request.method).toBe('POST');
      req.flush({});
    });

    it('should delete alert', () => {
      service.deleteAlert('a1').subscribe();
      const req = httpMock.expectOne('/api/alerts/a1');
      expect(req.request.method).toBe('DELETE');
      req.flush({});
    });
  });

  describe('Auth', () => {
    it('should login', () => {
      service.login('test@test.com').subscribe();
      const req = httpMock.expectOne('/api/auth/login');
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({ email: 'test@test.com' });
      req.flush({ token: 'jwt-token' });
    });

    it('should get users', () => {
      service.getUsers().subscribe();
      const req = httpMock.expectOne('/api/users');
      expect(req.request.method).toBe('GET');
      req.flush([]);
    });
  });
});
