import { TestBed } from '@angular/core/testing';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { MetricsComponent } from './metrics.component';
import { ApiService } from '../../services/api.service';
import { of } from 'rxjs';

describe('MetricsComponent', () => {
  let apiService: jasmine.SpyObj<ApiService>;

  beforeEach(async () => {
    const spy = jasmine.createSpyObj('ApiService', ['getAggregatedMetrics']);

    await TestBed.configureTestingModule({
      imports: [MetricsComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: ApiService, useValue: spy },
      ],
    }).compileComponents();

    apiService = TestBed.inject(ApiService) as jasmine.SpyObj<ApiService>;
  });

  it('should create', () => {
    const fixture = TestBed.createComponent(MetricsComponent);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('should load aggregated metrics', async () => {
    apiService.getAggregatedMetrics.and.returnValue(of([
      { hour: '2024-01-01T00:00:00', avgCpu: 45.2, avgMemory: 256 },
    ]));

    const fixture = TestBed.createComponent(MetricsComponent);
    fixture.componentInstance.query.projectId = 'p1';

    await fixture.componentInstance.load();

    expect(fixture.componentInstance.aggregated.length).toBe(1);
    expect(fixture.componentInstance.loading).toBeFalse();
  });

  it('should set loading state', async () => {
    apiService.getAggregatedMetrics.and.returnValue(of([]));

    const fixture = TestBed.createComponent(MetricsComponent);
    fixture.componentInstance.query.projectId = 'p1';

    await fixture.componentInstance.load();

    expect(fixture.componentInstance.loading).toBeFalse();
  });
});
