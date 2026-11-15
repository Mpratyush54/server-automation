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
    expect(document.title).toBe('Environment Variables Reference | Cairn Docs');
    expect(document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href)
      .toBe('https://platform.pratyushes.dev/docs/api-reference/configuration/environment-variables');
  });

  it('lists the operations and Phase 4 guides, with root-level pages at /docs/<page>', () => {
    const pages = component.flatPages;
    for (const page of ['upgrades', 'telemetry-privacy', 'alerting', 'synthetics', 'database-monitoring', 'status-pages', 'heatmaps', 'frontend-rum', 'observability']) {
      expect(pages.some((p) => p.page === page)).withContext(page).toBeTrue();
    }
    const root = pages.find((p) => p.page === 'faq')!;
    expect(component.docUrl(root)).toBe('/docs/faq');
    const moved = pages.find((p) => p.page === 'host-hardening')!;
    expect(component.docUrl(moved)).toBe('/docs/guides/host-hardening');
    expect(pages.every((p) => !component.docUrl(p).includes('//'))).toBeTrue();
  });

  it('renders crawlable hrefs for nested navigation entries', () => {
    expect(fixture.nativeElement.querySelector('a[href="/docs/api-reference/configuration/environment-variables"]')).toBeTruthy();
  });

  it('groups the sidebar by task, starting with Get started', () => {
    expect(component.docSections.map((g) => g.label)).toEqual(['Get started', 'Guides', 'Operations', 'Reference', 'More']);
    const labels = (id: string) => component.docSections.find((g) => g.id === id)!.pages.map((p) => p.label);
    expect(labels('get-started')).toEqual(['What Cairn is', 'Install', 'Your first project', 'Deploy an app']);
    expect(labels('guides')).toEqual(['Build from Git', 'Databases', 'Backups and restore', 'Monitoring and alerts', 'Run on several servers', 'Security and sign-in', 'AI agents and MCP']);
    expect(labels('operations')).toEqual(['Upgrade', 'Recover', 'Troubleshooting']);
    expect(labels('reference')).toEqual(['CLI', 'API', 'Settings', 'SDKs']);
    expect(component.docUrl(component.flatPages[0])).toBe('/docs');
    const urls = component.flatPages.map((p) => component.docUrl(p));
    expect(new Set(urls).size).withContext('each page listed once').toBe(urls.length);
  });

  it('sends short addresses to their page and keeps old folder addresses working', () => {
    params.next(convertToParamMap({ section: 'install' }));
    expect(navigate).toHaveBeenCalledWith('/docs/getting-started/installation', { replaceUrl: true });
    params.next(convertToParamMap({ section: 'troubleshooting' }));
    expect(navigate).toHaveBeenCalledWith('/docs/troubleshooting/README', { replaceUrl: true });
    params.next(convertToParamMap({ section: 'guides' }));
    expect(navigate).toHaveBeenCalledWith('/docs/guides/databases', { replaceUrl: true });
  });

  it('sends the old addresses of pages that moved out of the docs root to their new place', () => {
    for (const [old, now] of [
      ['host-hardening', '/docs/guides/host-hardening'],
      ['namespace-isolation', '/docs/guides/namespace-isolation'],
      ['gitops-branches', '/docs/guides/gitops-branches'],
      ['observability-releases', '/docs/observability/releases'],
    ]) {
      params.next(convertToParamMap({ section: old }));
      expect(navigate).withContext(old).toHaveBeenCalledWith(now, { replaceUrl: true });
    }
  });

  it('shows a page\'s children only while it or a child is open, with a breadcrumb trail', async () => {
    params.next(convertToParamMap({ section: 'mcp', page: 'setup' }));
    await fixture.whenStable();
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.docs-nav-link.active')!.textContent!.trim()).toBe('Set up MCP');
    expect(el.querySelector('a[href="/docs/mcp/tools"]')).toBeTruthy();
    expect(el.querySelector('a[href="/docs/operations/alerting"]')).withContext('other children stay folded').toBeNull();
    const crumbs = Array.from(el.querySelectorAll('.docs-breadcrumb > :not(.docs-breadcrumb-sep)')).map((n) => n.textContent!.trim());
    expect(crumbs).toEqual(['Docs', 'Guides', 'AI agents and MCP', 'Set up MCP']);
  });

  it('turns blockquotes into callouts and labels code blocks with a Copy button', async () => {
    get.and.returnValue(of('# Page\n\nIntro.\n\n> [!WARNING]\n> Back up first.\n\n> Plain note.\n\n```bash\nsudo platformctl status\n```\n'));
    params.next(convertToParamMap({ section: 'operations', page: 'recover' }));
    await fixture.whenStable();
    fixture.detectChanges();
    const article: HTMLElement = fixture.nativeElement.querySelector('.docs-markdown');
    const warning = article.querySelector('blockquote.docs-callout-warning')!;
    expect(warning.querySelector('.docs-callout-label')!.textContent).toBe('Warning');
    expect(warning.textContent).toContain('Back up first.');
    expect(warning.textContent).not.toContain('[!WARNING]');
    expect(article.querySelector('blockquote.docs-callout-plain')).toBeTruthy();
    expect(article.querySelector('.docs-code-lang')!.textContent).toBe('bash');
    expect(article.querySelector('.docs-copy-btn')!.textContent).toBe('Copy');
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

  it('keeps Markdown and table-of-contents fragments on the current docs page', async () => {
    get.and.returnValue(of('# Installation\n\n[Local setup](#local-development)\n\n## Local development\n\nUse Docker.\n\n## Local development\n\nAnother setup.'));
    params.next(convertToParamMap({ section: 'getting-started', page: 'installation' }));
    await fixture.whenStable();
    fixture.detectChanges();
    const article = fixture.nativeElement.querySelector('.docs-markdown');
    const anchor = article.querySelector('a');
    expect(anchor.getAttribute('href')).toBe('/docs/getting-started/installation#local-development');
    expect(article.querySelector('#local-development')).toBeTruthy();
    expect(article.querySelector('#local-development-1')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('.docs-toc-link').getAttribute('href'))
      .toBe('/docs/getting-started/installation#local-development');
    anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(navigate).toHaveBeenCalledWith('/docs/getting-started/installation#local-development');
    navigate.calls.reset();
    const modifiedClick = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });
    anchor.dispatchEvent(modifiedClick);
    expect(modifiedClick.defaultPrevented).toBeFalse();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('sanitizes raw HTML and mermaid fences before rendering the article', async () => {
    get.and.returnValue(of('# XSS\n\n<img src=x onerror="window.__docsXss=1">\n\n```mermaid\ngraph TD\nA</div><script>window.__docsXss=1</script>\n```\n'));
    spyOn<any>(component, 'renderMermaidDiagrams').and.resolveTo();
    params.next(convertToParamMap({ section: 'getting-started', page: 'installation' }));
    await fixture.whenStable();
    fixture.detectChanges();
    const article: HTMLElement = fixture.nativeElement.querySelector('.docs-markdown');
    expect(article.querySelector('img')!.hasAttribute('onerror')).toBeFalse();
    expect(article.querySelector('script')).toBeNull();
    const diagram = article.querySelector('.mermaid')!;
    expect(diagram.children.length).toBe(0);
    expect(diagram.textContent).toContain('A</div><script>');
    expect((window as any).__docsXss).toBeUndefined();
  });

  it('resolves parent Markdown links and keeps API section fragment targets', async () => {
    get.and.returnValue(of('# Auth\n\n[Monitoring](../../guides/monitoring.md#logs)\n\n## `GET` /api/projects\n\nEndpoint.\n\n### `POST` /api/projects\n\nEndpoint.\n\n## Error Codes\n\nNone.'));
    params.next(convertToParamMap({ section: 'api-reference/platform-api', page: 'auth' }));
    await fixture.whenStable();
    fixture.detectChanges();
    const article = fixture.nativeElement.querySelector('.docs-markdown');
    expect(article.querySelector('a').getAttribute('href')).toBe('/docs/guides/monitoring#logs');
    expect(article.querySelector('.api-card#get-apiprojects')).toBeTruthy();
    expect(article.querySelector('.api-sub-card#post-apiprojects')).toBeTruthy();
    expect(article.querySelector('h2#error-codes')).toBeTruthy();
  });
});
