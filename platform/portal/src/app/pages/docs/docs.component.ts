import { Component, OnInit, OnDestroy, ViewEncapsulation, HostListener, ElementRef, AfterViewChecked, ChangeDetectorRef, inject, DOCUMENT } from '@angular/core';

import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { DomSanitizer, Meta, SafeHtml, Title } from '@angular/platform-browser';
import { marked } from 'marked';
import hljs from 'highlight.js';
import mermaid from 'mermaid';
import { catchError } from 'rxjs/operators';
import { of, Subscription } from 'rxjs';
import { prepareDocsHtml } from './docs-html.mjs';
import { DocsSearchComponent } from './docs-search.component';
import { sanitizeDocsHtml } from './docs-sanitize.mjs';
import { DOC_ALIASES, DOC_GROUPS, DocGroup, DocPage, docUrl, flattenPages } from './docs-nav';
import { SiteHeaderComponent } from '../../shared/site/site-header.component';

export type { DocPage, DocGroup } from './docs-nav';

const COPY_RESET_MS = 1500;
const HEADER_OFFSET = 88;

@Component({
  selector: 'app-docs',
  standalone: true,
  imports: [RouterModule, DocsSearchComponent, SiteHeaderComponent],
  encapsulation: ViewEncapsulation.None,
  templateUrl: './docs.component.html',
  styleUrl: './docs.component.css',
})
export class DocsComponent implements OnInit, OnDestroy, AfterViewChecked {
  private document = inject(DOCUMENT);
  private title = inject(Title);
  private meta = inject(Meta);
  content: SafeHtml | null = null;
  isLoading = true;
  currentSection = '';
  currentPage = '';
  mobileNavOpen = false;
  tocItems: { id: string; text: string; level: string }[] = [];
  activeTocId = '';
  /** Raw markdown for the current page (agent copy). */
  rawMarkdown = '';
  /** Path used to fetch the page, e.g. /docs/mcp/for-agents.md */
  markdownPath = '';
  agentCopyFeedback: 'prompt' | null = null;
  private agentCopyTimer: ReturnType<typeof setTimeout> | null = null;
  private rendering = false;
  private renderedHtml = '';
  private tocObserver: IntersectionObserver | null = null;
  private themeObserver: MutationObserver | null = null;
  private schemeQuery: MediaQueryList | null = null;
  private readonly onSchemeChange = () => this.rerenderForTheme();
  private routeSubscription?: Subscription;
  private loadSubscription?: Subscription;

  /** Sidebar groups (Get started, Guides, Operations, Reference, More). */
  readonly docSections: DocGroup[] = DOC_GROUPS;
  private readonly allPages = flattenPages(DOC_GROUPS);

  get flatPages(): DocPage[] {
    return this.allPages;
  }

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private http: HttpClient,
    private sanitizer: DomSanitizer,
    private el: ElementRef,
    private cdr: ChangeDetectorRef
  ) {
    marked.use({ gfm: true, breaks: false });
  }

  ngOnInit() {
    this.watchTheme();
    this.routeSubscription = this.route.paramMap.subscribe(params => {
      const section = params.get('section');
      const page = params.get('page');
      const requested = [section, page].filter(Boolean).join('/');

      // Reset scroll on every docs navigation. /docs/:section/:page is one
      // component, so the router's scroll restoration does not fire between pages.
      this.scrollToTop();
      this.mobileNavOpen = false;

      // Short addresses such as /docs/install.
      const alias = section && !page ? DOC_ALIASES[section] : undefined;
      if (alias) {
        this.router.navigateByUrl(alias, { replaceUrl: true });
        return;
      }

      // A folder (e.g. /docs/guides) opens the first page filed in it.
      const category = requested && this.flatPages.find(p =>
        p.page && (p.section === requested || p.section.startsWith(requested + '/'))
      );
      if (category) {
        this.router.navigateByUrl(this.docUrl(category), { replaceUrl: true });
        return;
      }
      if (section && page) {
        this.currentSection = section;
        this.currentPage = page;
        this.loadMarkdown(`/docs/${section}/${page}.md`);
      } else if (section) {
        this.currentSection = '';
        this.currentPage = section;
        this.loadMarkdown(`/docs/${section}.md`);
      } else {
        this.currentSection = '';
        this.currentPage = '';
        this.loadMarkdown('/docs/index.md');
      }
    });
  }

  ngOnDestroy() {
    this.routeSubscription?.unsubscribe();
    this.loadSubscription?.unsubscribe();
    this.tocObserver?.disconnect();
    this.themeObserver?.disconnect();
    this.schemeQuery?.removeEventListener?.('change', this.onSchemeChange);
    if (this.agentCopyTimer) clearTimeout(this.agentCopyTimer);
    this.updateMetadata(
      'Cairn — run your apps on your own servers',
      'Turn your Ubuntu server into a self-hosted developer platform. Deploy with GitOps, connect databases, manage secrets, and inspect logs with scoped MCP tools.',
      'https://platform.pratyushes.dev/'
    );
  }

  @HostListener('document:keydown.escape')
  closeNavOnEscape() {
    if (this.mobileNavOpen) this.mobileNavOpen = false;
  }

  private scrollToTop() {
    try { window.scrollTo({ top: 0, left: 0, behavior: 'auto' }); } catch { window.scrollTo(0, 0); }
  }

  ngAfterViewChecked() {
    if (this.rendering) {
      this.rendering = false;
      this.applySyntaxHighlighting();
      this.addCopyButtons();
      this.renderMermaidDiagrams();
      this.buildToc();
      this.cdr.detectChanges();
    }
  }

  // ── Navigation ────────────────────────────────────────────────────────────

  docUrl(page: Pick<DocPage, 'section' | 'page'>): string {
    return docUrl(page);
  }

  isActive(page: DocPage): boolean {
    return this.currentSection === page.section && this.currentPage === page.page;
  }

  /** A page's children are listed while it, or one of them, is open. */
  isExpanded(page: DocPage): boolean {
    return !!page.children?.length && (this.isActive(page) || page.children.some(c => this.isActive(c)));
  }

  isSectionActive(section: DocGroup): boolean {
    return section.pages.some(p => this.isActive(p) || (p.children ?? []).some(c => this.isActive(c)));
  }

  /** Group, parent (when the open page is a child) and page, for the breadcrumb. */
  get trail(): { group: DocGroup; parent: DocPage | null; page: DocPage } | null {
    for (const group of this.docSections) {
      for (const page of group.pages) {
        if (this.isActive(page)) return { group, parent: null, page };
        const child = page.children?.find(c => this.isActive(c));
        if (child) return { group, parent: page, page: child };
      }
    }
    return null;
  }

  get prevPage(): DocPage | null {
    const all = this.flatPages;
    const idx = all.findIndex(p => this.isActive(p));
    return idx > 0 ? all[idx - 1] : null;
  }

  get nextPage(): DocPage | null {
    const all = this.flatPages;
    const idx = all.findIndex(p => this.isActive(p));
    return idx >= 0 && idx < all.length - 1 ? all[idx + 1] : null;
  }

  /** Label for a page outside its sidebar context: SDK children read "Node.js quickstart". */
  pageLabel(page: DocPage): string {
    if (page.heading && page.label === 'Quickstart') return `${page.heading} quickstart`;
    return page.label;
  }

  getBreadcrumbTitle(): string {
    const found = this.trail;
    if (found) return this.pageLabel(found.page);
    if (!this.currentPage) return 'Overview';
    return this.currentPage.replace(/-/g, ' ').replace(/^\w/, c => c.toUpperCase());
  }

  @HostListener('click', ['$event'])
  onClick(event: MouseEvent) {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const target = event.target as HTMLElement;
    const anchor = target.closest('a');
    if (!anchor?.closest('.docs-markdown') || !anchor.getAttribute('href') || anchor.target === '_blank') return;
    const href = anchor.getAttribute('href')!;

    if (href.startsWith('/docs/') || href.startsWith('/docs#')) {
      event.preventDefault();
      this.router.navigateByUrl(href).then(() => this.scrollToFragment());
    }
  }

  navigateTo(page: DocPage) {
    this.mobileNavOpen = false;
    this.router.navigateByUrl(this.docUrl(page));
  }

  private updateMetadata(title: string, description: string, canonical: string) {
    this.title.setTitle(title);
    this.meta.updateTag({ name: 'description', content: description });
    this.meta.updateTag({ name: 'robots', content: 'index,follow,max-image-preview:large' });
    this.meta.updateTag({ property: 'og:title', content: title });
    this.meta.updateTag({ property: 'og:description', content: description });
    this.meta.updateTag({ property: 'og:url', content: canonical });
    this.meta.updateTag({ name: 'twitter:title', content: title });
    this.meta.updateTag({ name: 'twitter:description', content: description });
    let link = this.document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!link) {
      link = this.document.createElement('link');
      link.rel = 'canonical';
      this.document.head.appendChild(link);
    }
    link.href = canonical;
  }

  // ── Copy for AI agents ────────────────────────────────────────────────────

  /** Absolute URL for the raw .md twin of the current page. */
  get markdownAbsoluteUrl(): string {
    const path = this.markdownPath || '/docs/index.md';
    if (typeof window === 'undefined') return path;
    return `${window.location.origin}${path.startsWith('/') ? path : '/' + path}`;
  }

  get htmlAbsoluteUrl(): string {
    if (typeof window === 'undefined') return '';
    return window.location.href.split('#')[0];
  }

  get llmsTxtUrl(): string {
    if (typeof window === 'undefined') return '/llms.txt';
    return `${window.location.origin}/llms.txt`;
  }

  async copyAgentPrompt(): Promise<void> {
    if (!this.rawMarkdown) return;
    const title = this.getBreadcrumbTitle();
    const prompt = [
      `# Platform documentation — ${title}`,
      '',
      'Use this page as grounding. Prefer the Markdown source over scraped HTML.',
      `Page (HTML): ${this.htmlAbsoluteUrl}`,
      `Page (Markdown): ${this.markdownAbsoluteUrl}`,
      `Site agent index: ${this.llmsTxtUrl}`,
      `Full docs index: ${typeof window !== 'undefined' ? window.location.origin : ''}/llms-full.txt`,
      '',
      '---',
      '',
      this.rawMarkdown.trim(),
      '',
    ].join('\n');
    if (await this.writeClipboard(prompt)) {
      if (this.agentCopyTimer) clearTimeout(this.agentCopyTimer);
      this.agentCopyFeedback = 'prompt';
      this.agentCopyTimer = setTimeout(() => {
        this.agentCopyFeedback = null;
        this.cdr.detectChanges();
      }, COPY_RESET_MS);
    }
  }

  private async writeClipboard(text: string): Promise<boolean> {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      /* fall through */
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.className = 'docs-offscreen';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }

  // ── Loading and rendering ────────────────────────────────────────────────

  private async loadMarkdown(path: string) {
    this.loadSubscription?.unsubscribe();
    this.isLoading = true;
    this.content = null;
    this.rawMarkdown = '';
    this.markdownPath = path;
    this.agentCopyFeedback = null;
    this.loadSubscription = this.http.get(path, { responseType: 'text' })
      .pipe(
        catchError(() => {
          this.isLoading = false;
          this.content = null;
          this.rawMarkdown = '';
          this.meta.updateTag({ name: 'robots', content: 'noindex,follow' });
          return of(null);
        })
      )
      .subscribe(async (text) => {
        if (text) {
          try {
            this.rawMarkdown = text;
            const heading = text.match(/^#\s+(.+)$/m)?.[1].replace(/[*`]/g, '').trim() || 'Documentation';
            const title = `${heading} | Cairn Docs`;
            const description = `Read ${heading} in the Platform documentation. Guides and reference for the self-hosted Platform control plane.`;
            const canonical = 'https://platform.pratyushes.dev' + (path === '/docs/index.md' ? '/docs' : path.replace(/\.md$/, ''));
            this.updateMetadata(title, description, canonical);
            let html = prepareDocsHtml(await marked.parse(text), path, window.location.origin);
            html = this.enhanceApiDocs(html);
            html = this.enhanceAuthBadges(html);
            html = this.enhanceResponseSections(html);
            // Sanitize (and build mermaid containers from text) before
            // trusting: Angular's own sanitizer would strip the ids/classes
            // the docs layout relies on, so DOMPurify is the security boundary.
            html = sanitizeDocsHtml(html as string);
            // Post-sanitize additions only insert fixed markup.
            html = this.enhanceCallouts(html);
            this.renderedHtml = html;
            this.content = this.sanitizer.bypassSecurityTrustHtml(html);
            this.isLoading = false;
            this.rendering = true;
            this.cdr.detectChanges();
            // Re-scroll after content mounts: the initial scrollToTop ran
            // while the previous page was still on screen.
            queueMicrotask(() => { if (!this.scrollToFragment()) this.scrollToTop(); });
          } catch (e) {
            console.error('Error parsing markdown', e);
          }
        }
        this.isLoading = false;
      });
  }

  private applySyntaxHighlighting() {
    const container = this.el.nativeElement.querySelector('.docs-markdown');
    if (!container) return;
    container.querySelectorAll('pre code').forEach((block: unknown) => {
      const el = block as HTMLElement;
      if (el.dataset['highlighted']) return;
      hljs.highlightElement(el);
    });
    this.enhanceHighlighting(container);
  }

  private enhanceHighlighting(container: HTMLElement) {
    // Shell prompts and common CLIs highlight.js misses.
    container.querySelectorAll('pre code.language-bash, pre code.language-sh, pre code.language-shell').forEach((block: unknown) => {
      const el = block as HTMLElement;
      let html = el.innerHTML;
      html = html.replace(/^(\s*)(\$)\s/gm, '$1<span class="terminal-prompt">$2</span> ');
      const cliCommands = ['platformctl', 'docker', 'npm', 'git', 'kubectl', 'helm', 'ng', 'python', 'node', 'npx', 'sudo', 'apt', 'apt-get', 'curl'];
      const cliRegex = new RegExp(`(^|>|\\s)(${cliCommands.join('|')})(?=\\s|$)`, 'gm');
      html = html.replace(cliRegex, '$1<span class="hljs-built_in">$2</span>');
      el.innerHTML = html;
    });

    // Env files: KEY=value.
    container.querySelectorAll('pre code.language-env, pre code.language-dotenv, pre code.language-properties').forEach((block: unknown) => {
      const el = block as HTMLElement;
      el.innerHTML = el.innerHTML.replace(/^([A-Z0-9_]+)=(.+)$/gm, (_m, key, value) => {
        const cleanKey = key.replace(/<[^>]*>/g, '');
        const cleanVal = value.replace(/<[^>]*>/g, '');
        return `<span class="hljs-attr">${cleanKey}</span>=<span class="hljs-string">${cleanVal}</span>`;
      });
    });

    // HTTP request/response blocks.
    container.querySelectorAll('pre code.language-http').forEach((block: unknown) => {
      const el = block as HTMLElement;
      let html = el.innerHTML;
      html = html.replace(
        /^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)(\s+)([^ \n]+)(\s+HTTP\/[0-9.]+)/gm,
        '<span class="http-method">$1</span>$2<span class="http-path">$3</span><span class="http-version">$4</span>'
      );
      html = html.replace(/^([A-Za-z0-9-]+):(\s*)(.+)$/gm, '<span class="http-header">$1</span>:$2$3');
      el.innerHTML = html;
    });
  }

  /** Code blocks get a header with the language and a Copy button. */
  private addCopyButtons() {
    const container = this.el.nativeElement.querySelector('.docs-markdown');
    if (!container) return;
    container.querySelectorAll('pre').forEach((pre: unknown) => {
      const el = pre as HTMLElement;
      if (el.querySelector('.docs-copy-btn') || el.closest('.mermaid')) return;

      const lang = (el.querySelector('code')?.className.match(/language-([\w+-]+)/) || [])[1] || 'text';

      const header = document.createElement('div');
      header.className = 'docs-code-header';

      const langLabel = document.createElement('span');
      langLabel.className = 'docs-code-lang';
      langLabel.textContent = lang;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'docs-copy-btn';
      btn.textContent = 'Copy';
      btn.setAttribute('aria-label', `Copy ${lang} code`);

      let timer: ReturnType<typeof setTimeout> | null = null;
      btn.addEventListener('click', async () => {
        const code = el.querySelector('code')?.textContent || '';
        if (!(await this.writeClipboard(code))) return;
        btn.textContent = 'Copied';
        btn.classList.add('copied');
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          btn.textContent = 'Copy';
          btn.classList.remove('copied');
        }, COPY_RESET_MS);
      });

      header.appendChild(langLabel);
      header.appendChild(btn);
      el.insertBefore(header, el.firstChild);
    });
  }

  /**
   * Blockquotes become callouts. `> [!NOTE]`, `> [!TIP]`, `> [!WARNING]`,
   * `> [!IMPORTANT]`, `> [!CAUTION]` (GitHub syntax) or a leading
   * `**Note:**` / `**Warning:**` choose the kind; others are plain notes.
   */
  private enhanceCallouts(html: string): string {
    const kinds: Record<string, { cls: string; label: string }> = {
      note: { cls: 'note', label: 'Note' },
      tip: { cls: 'tip', label: 'Tip' },
      important: { cls: 'note', label: 'Important' },
      warning: { cls: 'warning', label: 'Warning' },
      caution: { cls: 'warning', label: 'Caution' },
    };
    return html.replace(/<blockquote>\s*<p>([\s\S]*?)<\/blockquote>/g, (whole, inner: string) => {
      const marker = inner.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(?:<br>)?\s*/i)
        || inner.match(/^<strong>(Note|Tip|Important|Warning|Caution):?<\/strong>:?\s*/i);
      if (!marker) return whole.replace('<blockquote>', '<blockquote class="docs-callout docs-callout-plain">');
      const kind = kinds[marker[1].toLowerCase()];
      let rest = inner.slice(marker[0].length);
      rest = rest.startsWith('</p>') ? rest.slice(4) : `<p>${rest}`;
      return `<blockquote class="docs-callout docs-callout-${kind.cls}"><p class="docs-callout-label">${kind.label}</p>${rest}</blockquote>`;
    });
  }

  private enhanceApiDocs(html: string): string {
    const parts = html.split(/(<h2[^>]*>.*?<\/h2>)/i);
    const out: string[] = [];
    let cardOpen = false;

    for (const part of parts) {
      const m = part.match(/<h2[^>]*>\s*<code>(GET|POST|PUT|PATCH|DELETE)<\/code>\s+(.+?)<\/h2>/i);
      if (m) {
        if (cardOpen) { out.push('</div></div>'); }
        const id = part.match(/<h2\b[^>]*\bid="([^"]+)"/)?.[1];
        out.push(`<div class="api-card"${id ? ` id="${id}"` : ''}><div class="api-card-header"><span class="api-method method-${m[1].toLowerCase()}">${m[1]}</span><code class="api-path">${m[2].trim()}</code></div><div class="api-card-body">`);
        cardOpen = true;
      } else {
        out.push(part);
      }
    }
    if (cardOpen) { out.push('</div></div>'); }

    return out.join('').replace(
      /<h3([^>]*)>\s*<code>(GET|POST|PUT|PATCH|DELETE)<\/code>\s+(.+?)<\/h3>/gi,
      (_heading, attributes: string, method: string, path: string) => {
        const id = attributes.match(/\bid="([^"]+)"/)?.[1];
        return `<div class="api-sub-card"${id ? ` id="${id}"` : ''}><div class="api-card-header"><span class="api-method method-${method.toLowerCase()}">${method}</span><code class="api-path">${path}</code></div></div>`;
      }
    );
  }

  private enhanceAuthBadges(html: string): string {
    return html.replace(
      /<p><strong>Auth:<\/strong>\s*(.*?)<\/p>/gi,
      (_m, text: string) => {
        const isNone = /none/i.test(text);
        return `<p class="auth-row"><span class="api-auth-label">Auth</span><span class="api-auth-value">${isNone ? 'Not required' : text.trim()}</span></p>`;
      }
    );
  }

  private enhanceResponseSections(html: string): string {
    return html
      .replace(/<p><strong>Response\s+`(\d+)`:<\/strong><\/p>/gi, '<p class="api-sub-header"><span class="response-code">$1</span>Response</p>')
      .replace(/<p><strong>Request Body:<\/strong><\/p>/gi, '<p class="api-sub-header">Request body</p>')
      .replace(/<p><strong>Query Parameters:<\/strong><\/p>/gi, '<p class="api-sub-header">Query parameters</p>')
      .replace(/<p><strong>Error\s+`(\d+)`:<\/strong><\/p>/gi, '<p class="api-sub-header"><span class="response-code response-code-error">$1</span>Error response</p>');
  }

  // ── Table of contents ────────────────────────────────────────────────────

  scrollToHeading(event: Event, id: string) {
    if (event instanceof MouseEvent && (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)) return;
    event.preventDefault();
    this.activeTocId = id;
    this.router.navigateByUrl(this.headingUrl(id)).then(() => this.scrollToFragment());
  }

  headingUrl(id: string): string {
    const path = this.markdownPath === '/docs/index.md' ? '/docs' : this.markdownPath.replace(/\.md$/, '');
    return `${path}#${encodeURIComponent(id)}`;
  }

  private scrollToFragment(): boolean {
    const id = this.router.parseUrl(this.router.url).fragment;
    if (!id) return false;
    const el = this.el.nativeElement.querySelector(`[id="${CSS.escape(id)}"]`) as HTMLElement | null;
    if (el) {
      const top = el.getBoundingClientRect().top + window.scrollY - HEADER_OFFSET;
      window.scrollTo({ top, behavior: 'auto' });
    }
    return !!el;
  }

  private buildToc() {
    this.tocItems = [];
    this.activeTocId = '';
    this.tocObserver?.disconnect();
    this.tocObserver = null;
    const container = this.el.nativeElement.querySelector('.docs-markdown');
    if (!container) return;
    const headings: HTMLElement[] = Array.from(container.querySelectorAll('h2, h3'));
    if (headings.length === 0) return;

    for (const el of headings) {
      this.tocItems.push({ id: el.id, text: el.textContent || '', level: el.tagName.toLowerCase() });
    }
    this.activeTocId = headings[0].id;
    if (typeof IntersectionObserver === 'undefined') return;

    this.tocObserver = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter(e => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        // At the top of the page the first heading is current, even before it reaches the band.
        const next = window.scrollY < 40 ? headings[0].id : visible[0]?.target.id;
        if (next && next !== this.activeTocId) {
          this.activeTocId = next;
          this.cdr.detectChanges();
        }
      },
      { rootMargin: `-${HEADER_OFFSET}px 0px -65% 0px`, threshold: 0 }
    );
    for (const el of headings) if (el.id) this.tocObserver.observe(el);
  }

  // ── Diagrams ─────────────────────────────────────────────────────────────

  /** Re-render diagrams when the theme changes so their colours follow it. */
  private watchTheme() {
    if (typeof MutationObserver !== 'undefined') {
      this.themeObserver = new MutationObserver(() => this.rerenderForTheme());
      this.themeObserver.observe(this.document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      this.schemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
      this.schemeQuery.addEventListener?.('change', this.onSchemeChange);
    }
  }

  private rerenderForTheme() {
    if (!this.renderedHtml || !this.el.nativeElement.querySelector('.docs-markdown .mermaid')) return;
    this.content = this.sanitizer.bypassSecurityTrustHtml(this.renderedHtml);
    this.rendering = true;
    this.cdr.detectChanges();
  }

  /** Mermaid colours from the Signal tokens of the active theme. */
  private mermaidTheme() {
    const css = getComputedStyle(this.document.documentElement);
    const hex = (name: string, fallback: string) => {
      const parts = css.getPropertyValue(name).trim().split(/[\s,]+/).map(Number);
      if (parts.length < 3 || parts.some(n => Number.isNaN(n))) return fallback;
      return '#' + parts.slice(0, 3).map(n => n.toString(16).padStart(2, '0')).join('');
    };
    const dark = css.getPropertyValue('color-scheme').includes('dark');
    const surface = hex('--surface', '#ffffff');
    const raised = hex('--raised', '#eceef1');
    const fg = hex('--fg', '#191c20');
    const lineStrong = hex('--line-strong', '#c0c5cc');
    const canvas = hex('--canvas', '#f3f4f6');
    return {
      theme: 'base' as const,
      darkMode: dark,
      themeVariables: {
        darkMode: dark,
        background: surface,
        primaryColor: raised,
        primaryTextColor: fg,
        primaryBorderColor: lineStrong,
        secondaryColor: surface,
        tertiaryColor: canvas,
        lineColor: hex('--fg-3', '#707780'),
        textColor: fg,
        mainBkg: raised,
        nodeBorder: lineStrong,
        clusterBkg: surface,
        clusterBorder: lineStrong,
        edgeLabelBackground: surface,
        actorBkg: raised,
        actorBorder: lineStrong,
        signalColor: fg,
        noteBkgColor: surface,
        noteBorderColor: hex('--accent', '#f2b53a'),
        fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
        fontSize: '14px',
      },
    };
  }

  private async renderMermaidDiagrams() {
    const container = this.el.nativeElement.querySelector('.docs-markdown');
    if (!container) return;
    const mermaidNodes = container.querySelectorAll('.mermaid:not([data-processed])') as NodeListOf<HTMLElement>;
    if (mermaidNodes.length === 0) return;
    mermaid.initialize({
      startOnLoad: false,
      // Diagram labels must never render HTML/script.
      securityLevel: 'strict',
      // Mermaid 12 defaults to ELK and the "neo" look; keep dagre/classic.
      layout: 'dagre',
      look: 'classic',
      ...this.mermaidTheme(),
      flowchart: { curve: 'basis', padding: 16, nodeSpacing: 48, rankSpacing: 64 },
      sequence: { mirrorActors: false, actorMargin: 64, boxMargin: 12, messageMargin: 40 },
    });
    // One diagram at a time so a broken one does not stop the rest; show its
    // error and source instead of a blank space.
    for (const node of Array.from(mermaidNodes)) {
      const original = node.textContent || '';
      try {
        await mermaid.run({ nodes: [node] });
      } catch (e: any) {
        console.error('Mermaid render error:', e);
        node.setAttribute('data-processed', 'true');
        node.classList.add('mermaid-error');
        node.textContent = '';
        const title = document.createElement('p');
        title.className = 'mermaid-error-title';
        title.textContent = 'This diagram could not be drawn';
        const message = document.createElement('p');
        message.className = 'mermaid-error-message';
        message.textContent = String(e?.message || e || 'Mermaid parse error');
        const source = document.createElement('pre');
        source.className = 'mermaid-error-source';
        source.textContent = original;
        node.append(title, message, source);
      }
    }
    this.enhanceDiagramViewers();
  }

  /** Full-size diagram overlay: scrollable, closes on Esc, backdrop or Close. */
  private openDiagram(svg: SVGSVGElement, naturalWidth: number, returnFocus: HTMLElement) {
    const doc = this.document;
    const overlay = doc.createElement('div');
    overlay.className = 'docs-diagram-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Diagram, full size');
    const panel = doc.createElement('div');
    panel.className = 'docs-diagram-overlay-panel';
    const head = doc.createElement('div');
    head.className = 'docs-diagram-overlay-head';
    const label = doc.createElement('span');
    label.textContent = 'Diagram';
    const close = doc.createElement('button');
    close.type = 'button';
    close.className = 'docs-diagram-btn';
    close.textContent = 'Close';
    head.append(label, close);
    const body = doc.createElement('div');
    body.className = 'docs-diagram-overlay-body';
    const copy = svg.cloneNode(true) as SVGSVGElement;
    copy.style.width = Math.round(naturalWidth) + 'px';
    copy.style.height = 'auto';
    body.appendChild(copy);
    panel.append(head, body);
    overlay.appendChild(panel);
    const prevOverflow = doc.body.style.overflow;
    doc.body.style.overflow = 'hidden';
    const done = () => {
      overlay.remove();
      doc.body.style.overflow = prevOverflow;
      doc.removeEventListener('keydown', onKey, true);
      returnFocus.focus();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); done(); } };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(); });
    close.addEventListener('click', done);
    doc.addEventListener('keydown', onKey, true);
    doc.body.appendChild(overlay);
    close.focus();
  }

  private enhanceDiagramViewers() {
    const container = this.el.nativeElement.querySelector('.docs-markdown') as HTMLElement | null;
    if (!container) return;
    const diagramNodes = Array.from(container.querySelectorAll<HTMLElement>('.mermaid')).filter(
      (node) => !node.closest('.docs-diagram-viewer') && !node.classList.contains('mermaid-error')
    );

    diagramNodes.forEach((node) => {
      const svg = node.querySelector('svg') as SVGSVGElement | null;
      if (!svg) return;
      // Natural size from the viewBox; Mermaid's own width/max-width are dropped
      // so the diagram is drawn at a readable size instead of being shrunk.
      const vb = svg.viewBox?.baseVal;
      const naturalWidth = vb && vb.width ? vb.width : svg.getBoundingClientRect().width;
      svg.removeAttribute('width');
      svg.removeAttribute('height');
      svg.style.removeProperty('max-width');

      const viewer = document.createElement('figure');
      viewer.className = 'docs-diagram-viewer';
      const canvas = document.createElement('div');
      canvas.className = 'docs-diagram-canvas';
      canvas.tabIndex = 0;
      canvas.setAttribute('role', 'group');
      canvas.setAttribute('aria-label', 'Diagram');
      node.parentNode?.insertBefore(viewer, node);
      canvas.appendChild(node);
      viewer.appendChild(canvas);

      // On the page the whole diagram fits the column; "View full size" opens it
      // at its natural size in an overlay where it can be read and scrolled.
      const layout = () => {
        const available = Math.max(canvas.clientWidth - 32, 240);
        const width = Math.min(naturalWidth, available);
        svg.style.width = Math.round(width) + 'px';
        svg.style.height = 'auto';
        bar.hidden = naturalWidth <= available * 1.15;
      };

      const bar = document.createElement('figcaption');
      bar.className = 'docs-diagram-bar';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'docs-diagram-btn';
      btn.textContent = 'View full size';
      btn.addEventListener('click', () => this.openDiagram(svg, naturalWidth, btn));
      bar.appendChild(btn);
      viewer.appendChild(bar);
      canvas.addEventListener('click', () => { if (!bar.hidden) this.openDiagram(svg, naturalWidth, btn); });
      canvas.classList.add('is-zoomable');

      requestAnimationFrame(layout);
      if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => layout()).observe(canvas);
    });
  }
}
