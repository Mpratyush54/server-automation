import { TestBed } from '@angular/core/testing';
import { ActivatedRoute } from '@angular/router';
import { IframeViewComponent } from './iframe-view.component';
import { of } from 'rxjs';

describe('IframeViewComponent', () => {
  let route: any;

  beforeEach(async () => {
    route = {
      data: of({ url: '/argocd/' })
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
});
