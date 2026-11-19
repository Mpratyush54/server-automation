import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { BootstrapComponent } from './bootstrap.component';
import { ApiService } from '../../services/api.service';
import { of, throwError } from 'rxjs';

describe('BootstrapComponent', () => {
  let apiService: jasmine.SpyObj<ApiService>;

  beforeEach(async () => {
    const spy = jasmine.createSpyObj('ApiService', ['getBootstrapStatus']);

    await TestBed.configureTestingModule({
      imports: [BootstrapComponent],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: spy },
      ],
    }).compileComponents();

    apiService = TestBed.inject(ApiService) as jasmine.SpyObj<ApiService>;
  });

  it('should create', () => {
    const fixture = TestBed.createComponent(BootstrapComponent);
    fixture.detectChanges();
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('shows the platformctl install, not the removed bash installer', () => {
    const fixture = TestBed.createComponent(BootstrapComponent);
    const cmd = fixture.componentInstance.installCmd;
    expect(cmd).toContain('https://get.cairnpaas.dev');
    expect(cmd).toContain('sudo platformctl provision');
    expect(cmd).not.toContain('bootstrap.sh');
  });

  it('should map service status from the bootstrap status endpoint', async () => {
    apiService.getBootstrapStatus.and.returnValue(of({
      services: { postgresql: 'running', redis: 'degraded' },
    }));

    const fixture = TestBed.createComponent(BootstrapComponent);
    const component = fixture.componentInstance;
    await component.loadStatus();

    const byLabel = (label: string) => component.statusServices.find(s => s.label === label);
    expect(byLabel('PostgreSQL')?.status).toBe('running');
    expect(byLabel('Redis')?.status).toBe('degraded');
    expect(byLabel('MongoDB')?.status).toBe('unknown');
    expect(component.loadingStatus).toBeFalse();
  });

  it('should mark integrations configured from the status response', async () => {
    apiService.getBootstrapStatus.and.returnValue(of({
      services: {},
      integrations: { github: true, clickup: false },
    }));

    const fixture = TestBed.createComponent(BootstrapComponent);
    const component = fixture.componentInstance;
    await component.loadStatus();

    const byKey = (key: string) => component.integrations.find(i => i.key === key);
    expect(byKey('github')?.configured).toBeTrue();
    expect(byKey('clickup')?.configured).toBeFalse();
    expect(byKey('gitlab')?.configured).toBeFalse();
  });

  it('should stop loading when the status request fails', async () => {
    apiService.getBootstrapStatus.and.returnValue(throwError(() => new Error('offline')));

    const fixture = TestBed.createComponent(BootstrapComponent);
    const component = fixture.componentInstance;
    await component.loadStatus();

    expect(component.statusServices).toEqual([]);
    expect(component.loadingStatus).toBeFalse();
  });
});
