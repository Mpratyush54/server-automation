import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import {
  provideHttpClientTesting,
  HttpTestingController,
} from '@angular/common/http/testing';
import { provideRouter, Router } from '@angular/router';
import { DocsSearchComponent } from './docs-search.component';

describe('DocsSearchComponent', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({
      imports: [DocsSearchComponent],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    }),
  );
  afterEach(() => TestBed.inject(HttpTestingController).verify());
  const index = {
    version: 1,
    documents: 1,
    entries: [
      {
        title: 'Secrets Management',
        heading: 'Key rotation',
        section: 'guides',
        url: '/docs/guides/secrets-management#key-rotation',
        text: 'SECRETS_ENCRYPTION_KEY encrypts secrets.',
      },
    ],
  };

  it('loads the index only when opened, searches content, and keeps a real section URL', () => {
    const fixture = TestBed.createComponent(DocsSearchComponent),
      component = fixture.componentInstance;
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    http.expectNone('/docs-search.json');
    component.openSearch();
    component.updateQuery('SECRETS_ENCRYPTION_KEY');
    http.expectOne('/docs-search.json').flush(index);
    fixture.detectChanges();
    expect(
      fixture.nativeElement
        .querySelector('[role="option"]')
        .getAttribute('href'),
    ).toBe(index.entries[0].url);
    const navigate = spyOn(
      TestBed.inject(Router),
      'navigateByUrl',
    ).and.resolveTo(true);
    component.onKeydown(new KeyboardEvent('keydown', { key: 'Enter' }));
    // Enter is handled only from the combobox, rather than stealing button actions.
    expect(navigate).not.toHaveBeenCalled();
    fixture.nativeElement.querySelector('input').dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(navigate).toHaveBeenCalledWith(index.entries[0].url);
    expect(component.isOpen).toBeFalse();
    component.openSearch();
    http.expectNone('/docs-search.json');
    fixture.destroy();
  });
  it('shows a recoverable load error, supports retry, and closes with Escape', () => {
    const fixture = TestBed.createComponent(DocsSearchComponent),
      component = fixture.componentInstance;
    component.openSearch();
    const http = TestBed.inject(HttpTestingController);
    http
      .expectOne('/docs-search.json')
      .flush('Unavailable', { status: 503, statusText: 'Unavailable' });
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('[role="alert"]').textContent,
    ).toContain('Search couldn’t load');
    component.loadIndex();
    http.expectOne('/docs-search.json').flush(index);
    component.onKeydown(
      new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }),
    );
    expect(component.isOpen).toBeFalse();
    fixture.destroy();
  });
});
