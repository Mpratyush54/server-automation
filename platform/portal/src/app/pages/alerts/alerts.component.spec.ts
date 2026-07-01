import { TestBed } from '@angular/core/testing';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { AlertsComponent } from './alerts.component';
import { ApiService } from '../../services/api.service';
import { of } from 'rxjs';

describe('AlertsComponent', () => {
  let apiService: jasmine.SpyObj<ApiService>;

  beforeEach(async () => {
    const spy = jasmine.createSpyObj('ApiService', ['getAlerts', 'createAlert', 'deleteAlert']);

    await TestBed.configureTestingModule({
      imports: [AlertsComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: ApiService, useValue: spy },
      ],
    }).compileComponents();

    apiService = TestBed.inject(ApiService) as jasmine.SpyObj<ApiService>;
    apiService.getAlerts.and.returnValue(of([]));
  });

  it('should create', () => {
    const fixture = TestBed.createComponent(AlertsComponent);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('should load alerts on init', async () => {
    apiService.getAlerts.and.returnValue(of([
      { id: 'a1', type: 'cpu', threshold: 80 },
    ]));

    const fixture = TestBed.createComponent(AlertsComponent);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(fixture.componentInstance.alerts.length).toBe(1);
    expect(fixture.componentInstance.loading).toBeFalse();
  });

  it('should create an alert', async () => {
    apiService.getAlerts.and.returnValue(of([{ id: 'a2' }]));
    apiService.createAlert.and.returnValue(of({}));

    const fixture = TestBed.createComponent(AlertsComponent);
    fixture.componentInstance.newAlert = { projectId: 'p1', metric: 'cpu', operator: '>', threshold: 80 };

    await fixture.componentInstance.createAlert();

    expect(apiService.createAlert).toHaveBeenCalled();
    expect(fixture.componentInstance.alerts.length).toBe(1);
  });

  it('should delete an alert', async () => {
    spyOn(window, 'confirm').and.returnValue(true);
    apiService.deleteAlert.and.returnValue(of({}));

    const fixture = TestBed.createComponent(AlertsComponent);
    fixture.componentInstance.alerts = [{ id: 'a1' }];

    await fixture.componentInstance.deleteAlert('a1');

    expect(fixture.componentInstance.alerts.length).toBe(0);
  });

  it('should not delete when confirmation cancelled', async () => {
    spyOn(window, 'confirm').and.returnValue(false);

    const fixture = TestBed.createComponent(AlertsComponent);
    fixture.componentInstance.alerts = [{ id: 'a1' }];

    await fixture.componentInstance.deleteAlert('a1');

    expect(fixture.componentInstance.alerts.length).toBe(1);
  });
});
