import { TestBed } from '@angular/core/testing';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { BootstrapComponent } from './bootstrap.component';
import { ApiService } from '../../services/api.service';
import { of } from 'rxjs';

describe('BootstrapComponent', () => {
  let apiService: jasmine.SpyObj<ApiService>;

  beforeEach(async () => {
    const spy = jasmine.createSpyObj('ApiService', ['bootstrapInit', 'getBootstrapStatus']);

    await TestBed.configureTestingModule({
      imports: [BootstrapComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: ApiService, useValue: spy },
      ],
    }).compileComponents();

    apiService = TestBed.inject(ApiService) as jasmine.SpyObj<ApiService>;
  });

  it('should create', () => {
    const fixture = TestBed.createComponent(BootstrapComponent);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('should initialize bootstrap', async () => {
    apiService.bootstrapInit.and.returnValue(of({ success: true, token: 'abc' }));

    const fixture = TestBed.createComponent(BootstrapComponent);
    fixture.componentInstance.initData = { hostname: 'node-1', components: 'api,worker' };

    await fixture.componentInstance.init();

    expect(fixture.componentInstance.result).toEqual({ success: true, token: 'abc' });
    expect(fixture.componentInstance.loading).toBeFalse();
  });

  it('should check system status', async () => {
    apiService.getBootstrapStatus.and.returnValue(of({
      services: { postgres: 'running', redis: 'running' },
    }));

    const fixture = TestBed.createComponent(BootstrapComponent);
    await fixture.componentInstance.checkStatus();

    expect(fixture.componentInstance.statusServices.length).toBe(2);
  });

  it('should parse comma-separated components', async () => {
    apiService.bootstrapInit.and.returnValue(of({}));

    const fixture = TestBed.createComponent(BootstrapComponent);
    fixture.componentInstance.initData = { hostname: 'node-1', components: 'api, worker, scheduler' };

    await fixture.componentInstance.init();

    expect(apiService.bootstrapInit).toHaveBeenCalledWith(
      jasmine.objectContaining({
        components: ['api', 'worker', 'scheduler'],
      })
    );
  });
});
