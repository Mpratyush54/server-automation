import { ComponentFixture, TestBed } from '@angular/core/testing';
import { DocsComponent } from './docs.component';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, of } from 'rxjs';

describe('DocsComponent', () => {
  let component: DocsComponent;
  let fixture: ComponentFixture<DocsComponent>;
  let params: BehaviorSubject<ReturnType<typeof convertToParamMap>>;
  let get: jasmine.Spy;
  let navigate: jasmine.Spy;

  beforeEach(async () => {
    params = new BehaviorSubject(convertToParamMap({}));
    get = jasmine.createSpy('get').and.returnValue(of('# Environment Variables Reference\n\nAPI configuration.'));
    await TestBed.configureTestingModule({
      imports: [DocsComponent],
      providers: [
        provideRouter([]),
        { provide: ActivatedRoute, useValue: { paramMap: params } },
      ],
    }).overrideComponent(DocsComponent, {
      add: { providers: [{ provide: HttpClient, useValue: { get } }] },
    }).compileComponents();

    navigate = spyOn(TestBed.inject(Router), 'navigateByUrl').and.resolveTo(true);
    fixture = TestBed.createComponent(DocsComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('loads a pasted nested page and gives it its own canonical and title', async () => {
    params.next(convertToParamMap({ section: 'api-reference/configuration', page: 'environment-variables' }));
    await fixture.whenStable();
    expect(get).toHaveBeenCalledWith('/docs/api-reference/configuration/environment-variables.md', { responseType: 'text' });
    expect(document.title).toBe('Environment Variables Reference | Platform Docs');
    expect(document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href)
      .toBe('https://platform.pratyushes.dev/docs/api-reference/configuration/environment-variables');
  });

  it('renders crawlable hrefs for nested navigation entries', () => {
    expect(fixture.nativeElement.querySelector('a[href="/docs/api-reference/configuration/environment-variables"]')).toBeTruthy();
  });

  it('preserves every segment and fragment in Markdown navigation', () => {
    const article = document.createElement('div');
    article.className = 'docs-markdown';
    article.innerHTML = '<a href="/docs/api-reference/platform-api/auth#login">Authentication</a>';
    fixture.nativeElement.appendChild(article);
    article.querySelector('a')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(navigate).toHaveBeenCalledWith('/docs/api-reference/platform-api/auth#login');
  });

  it('resolves nested category URLs to a valid article without encoding slashes', () => {
    params.next(convertToParamMap({ section: 'api-reference', page: 'configuration' }));
    expect(navigate).toHaveBeenCalledWith('/docs/api-reference/configuration/environment-variables', { replaceUrl: true });
  });
});
