import { TestBed } from '@angular/core/testing';
import { ActivatedRoute } from '@angular/router';
import { IframeViewComponent } from './iframe-view.component';
import { BehaviorSubject, of } from 'rxjs';

describe('IframeViewComponent', () => {
  let route: any;

  beforeEach(async () => {
    route = {
      data: of({ url: '/grafana/' })
    };

    await TestBed.configureTestingModule({
      imports: [IframeViewComponent],
      providers: [
        { provide: ActivatedRoute, useValue: route }
      ]
    }).compileComponents();
  });

  it('should create', () => {
    const fixture = TestBed.createComponent(IframeViewComponent);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('should resolve and sanitize URL based on data path', () => {
    const fixture = TestBed.createComponent(IframeViewComponent);
    fixture.detectChanges();
    expect(fixture.componentInstance.safeUrl).toBeDefined();
  });

  it('stops listening to route data when destroyed', () => {
    const data = new BehaviorSubject<Record<string, string>>({ url: '/grafana/' });
    route.data = data;
    const fixture = TestBed.createComponent(IframeViewComponent);
    fixture.detectChanges();
    expect(data.observed).toBeTrue();
    fixture.destroy();
    expect(data.observed).toBeFalse();
  });
});
