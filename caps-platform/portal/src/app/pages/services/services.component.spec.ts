import { TestBed } from '@angular/core/testing';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { ServicesComponent } from './services.component';
import { ApiService } from '../../services/api.service';
import { of } from 'rxjs';

describe('ServicesComponent', () => {
  let apiService: jasmine.SpyObj<ApiService>;

  beforeEach(async () => {
    const spy = jasmine.createSpyObj('ApiService', ['getProjects', 'registerService']);

    await TestBed.configureTestingModule({
      imports: [ServicesComponent],
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
    const fixture = TestBed.createComponent(ServicesComponent);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('should load registrations from projects', async () => {
    apiService.getProjects.and.returnValue(of([
      { id: 'p1', registrations: [{ id: 'r1', serviceName: 'svc1' }] },
      { id: 'p2', registrations: [] },
    ]));

    const fixture = TestBed.createComponent(ServicesComponent);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(fixture.componentInstance.registrations.length).toBe(1);
  });

  it('should register a service', async () => {
    apiService.registerService.and.returnValue(of({}));
    spyOn(window, 'alert');

    const fixture = TestBed.createComponent(ServicesComponent);
    fixture.componentInstance.reg = {
      serviceName: 'my-svc',
      projectName: 'test',
      environmentName: 'production',
      version: '1.0.0',
      branch: 'main',
      dbTypes: 'postgres,redis',
    };

    await fixture.componentInstance.register();

    expect(apiService.registerService).toHaveBeenCalledWith(jasmine.objectContaining({
      serviceName: 'my-svc',
      dbTypes: ['postgres', 'redis'],
    }));
    expect(window.alert).toHaveBeenCalledWith('Service registered successfully');
  });
});
