import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { ErrorsComponent } from './errors.component';

describe('ErrorsComponent', () => {
  let http: HttpTestingController;

  function setup(projectId: string | null) {
    TestBed.configureTestingModule({
      imports: [ErrorsComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap(projectId ? { id: projectId } : {}), queryParamMap: convertToParamMap({}) } } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    return TestBed.createComponent(ErrorsComponent);
  }

  afterEach(() => http.verify());

  it('prompts to choose a project on the global page instead of showing an empty result', async () => {
    const fixture = setup(null);
    fixture.detectChanges();
    http.expectOne('/api/projects').flush([{ id: 'p1', name: 'shop' }]);
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="errors-choose-project"]')?.textContent).toContain('Choose a project');
    expect(el.querySelector('[data-testid="errors-empty"]')).toBeNull();
    expect(el.querySelector('table')).toBeNull();
    expect(el.querySelector('h1.page-title')?.textContent).toContain('Errors');
  });

  it('shows an empty-state row when a project has no issues', async () => {
    const fixture = setup('p1');
    fixture.detectChanges();
    http.expectOne('/api/projects').flush([{ id: 'p1', name: 'shop' }]);
    await Promise.resolve();
    http.expectOne((r) => r.url === '/api/projects/p1/errors').flush([]);
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="errors-empty"]')?.textContent).toContain('No issues');
    expect(el.querySelector('[data-testid="errors-choose-project"]')).toBeNull();
    expect(el.querySelector('table')?.parentElement?.classList).toContain('table-scroll');
  });

  it('explains when an issue has no stored events', async () => {
    const fixture = setup(null);
    const c = fixture.componentInstance;
    fixture.detectChanges();
    http.expectOne('/api/projects').flush([{ id: 'p1', name: 'shop' }]);
    await fixture.whenStable();
    c.project = 'p1';
    c.detail = { issue: { id: 'e1', title: 'TypeError: boom', release_counts: { '1.0.0': 4 } }, events: [] };
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="error-detail-no-events"]')?.textContent).toContain('retention policy');
    expect(el.textContent).toContain('1.0.0: 4');
  });
});
