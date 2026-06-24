import { TestBed } from '@angular/core/testing';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { LogsComponent } from './logs.component';
import { ApiService } from '../../services/api.service';
import { of } from 'rxjs';

describe('LogsComponent', () => {
  let apiService: jasmine.SpyObj<ApiService>;

  beforeEach(async () => {
    const spy = jasmine.createSpyObj('ApiService', ['searchLogs']);

    await TestBed.configureTestingModule({
      imports: [LogsComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: ApiService, useValue: spy },
      ],
    }).compileComponents();

    apiService = TestBed.inject(ApiService) as jasmine.SpyObj<ApiService>;
  });

  it('should create', () => {
    const fixture = TestBed.createComponent(LogsComponent);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('should have default query values', () => {
    const fixture = TestBed.createComponent(LogsComponent);
    const comp = fixture.componentInstance;
    expect(comp.query.projectId).toBe('');
    expect(comp.query.level).toBe('');
    expect(comp.logs.length).toBe(0);
  });

  it('should search logs', async () => {
    apiService.searchLogs.and.returnValue(of({
      logs: [{ message: 'test log' }],
      total: 1,
    }));

    const fixture = TestBed.createComponent(LogsComponent);
    fixture.componentInstance.query = { projectId: 'p1', serviceName: '', level: 'INFO', search: '' };

    await fixture.componentInstance.search();

    expect(fixture.componentInstance.logs.length).toBe(1);
    expect(fixture.componentInstance.total).toBe(1);
    expect(fixture.componentInstance.loading).toBeFalse();
  });

  it('should pass query params correctly', async () => {
    apiService.searchLogs.and.returnValue(of({ logs: [], total: 0 }));

    const fixture = TestBed.createComponent(LogsComponent);
    fixture.componentInstance.query = { projectId: 'p1', serviceName: 'svc', level: 'ERROR', search: 'fail' };

    await fixture.componentInstance.search();

    expect(apiService.searchLogs).toHaveBeenCalledWith({
      projectId: 'p1',
      serviceName: 'svc',
      level: 'ERROR',
      search: 'fail',
    });
  });

  it('should not send empty params', async () => {
    apiService.searchLogs.and.returnValue(of({ logs: [], total: 0 }));

    const fixture = TestBed.createComponent(LogsComponent);
    fixture.componentInstance.query = { projectId: '', serviceName: '', level: '', search: '' };

    await fixture.componentInstance.search();

    expect(apiService.searchLogs).toHaveBeenCalledWith({});
  });
});
