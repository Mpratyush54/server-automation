import { Component, OnInit, ViewEncapsulation, HostListener, ElementRef, AfterViewChecked, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { HttpClient, HttpClientModule } from '@angular/common/http';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { marked } from 'marked';
import hljs from 'highlight.js';
import mermaid from 'mermaid';
import { catchError } from 'rxjs/operators';
import { of } from 'rxjs';

interface DocPage {
  label: string;
  section: string;
  page: string;
}

interface DocSection {
  label: string;
  id: string;
  pages: DocPage[];
}

@Component({
  selector: 'app-docs',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule, HttpClientModule],
  encapsulation: ViewEncapsulation.None,
  templateUrl: './docs.component.html',
  styleUrl: './docs.component.css',
})
export class DocsComponent implements OnInit, AfterViewChecked {
  content: SafeHtml | null = null;
  isLoading = true;
  currentSection = '';
  currentPage = '';
  mobileNavOpen = false;
  searchQuery = '';
  tocItems: { id: string; text: string; level: string }[] = [];
  activeTocId = '';
  private rendering = false;
  private tocObserver: IntersectionObserver | null = null;

  docSections: DocSection[] = [
    {
      label: 'Getting Started', id: 'getting-started',
      pages: [
        { label: 'Installation', section: 'getting-started', page: 'installation' },
        { label: 'Project Structure', section: 'getting-started', page: 'project-structure' },
        { label: 'First Project', section: 'getting-started', page: 'first-project' },
        { label: 'Node.js Quickstart', section: 'getting-started', page: 'node-sdk-quickstart' },
        { label: 'React Quickstart', section: 'getting-started', page: 'react-sdk-quickstart' },
        { label: 'Angular Quickstart', section: 'getting-started', page: 'angular-sdk-quickstart' },
        { label: 'Python Quickstart', section: 'getting-started', page: 'python-sdk-quickstart' },
        { label: 'Deploy Your App', section: 'getting-started', page: 'deploy-your-app' },
        { label: 'Upgrade Guide', section: 'getting-started', page: 'upgrade-guide' },
      ],
    },
    {
      label: 'Guides', id: 'guides',
      pages: [
        { label: 'Authentication & RBAC', section: 'guides', page: 'authentication' },
        { label: 'Secrets Management', section: 'guides', page: 'secrets-management' },
        { label: 'Preview Environments', section: 'guides', page: 'preview-environments' },
        { label: 'Monitoring', section: 'guides', page: 'monitoring' },
        { label: 'Testing', section: 'guides', page: 'testing' },
        { label: 'Production Checklist', section: 'guides', page: 'production-checklist' },
      ],
    },
    {
      label: 'API Reference', id: 'api-reference',
      pages: [
        { label: 'Authentication', section: 'api-reference/platform-api', page: 'auth' },
        { label: 'Users & Roles', section: 'api-reference/platform-api', page: 'users' },
        { label: 'Projects', section: 'api-reference/platform-api', page: 'projects' },
        { label: 'Deployments', section: 'api-reference/platform-api', page: 'deployments' },
        { label: 'Databases', section: 'api-reference/platform-api', page: 'databases' },
        { label: 'Secrets', section: 'api-reference/platform-api', page: 'secrets' },
        { label: 'Files', section: 'api-reference/platform-api', page: 'files' },
        { label: 'Metrics', section: 'api-reference/platform-api', page: 'metrics' },
        { label: 'Audit Logs', section: 'api-reference/platform-api', page: 'audit-logs' },
        { label: 'Webhooks', section: 'api-reference/platform-api', page: 'webhooks' },
        { label: 'OAuth / OIDC', section: 'api-reference/platform-api', page: 'oauth' },
      ],
    },
    {
      label: 'Node.js SDK', id: 'sdk-node',
      pages: [
        { label: 'PlatformClient', section: 'api-reference/sdk-node', page: 'PlatformClient' },
        { label: 'Express Middleware', section: 'api-reference/sdk-node', page: 'expressMiddleware' },
        { label: 'Console Capture', section: 'api-reference/sdk-node', page: 'captureConsole' },
        { label: 'File Storage', section: 'api-reference/sdk-node', page: 'storage' },
        { label: 'PostgreSQL', section: 'api-reference/sdk-node', page: 'db-postgres' },
        { label: 'MongoDB', section: 'api-reference/sdk-node', page: 'db-mongo' },
        { label: 'Redis', section: 'api-reference/sdk-node', page: 'db-redis' },
      ],
    },
    {
      label: 'React SDK', id: 'sdk-react',
      pages: [
        { label: 'PlatformProvider', section: 'api-reference/sdk-react', page: 'PlatformProvider' },
        { label: 'usePlatform', section: 'api-reference/sdk-react', page: 'usePlatform' },
        { label: 'Bug Reporter', section: 'api-reference/sdk-react', page: 'BugReporterWidget' },
        { label: 'ErrorBoundary', section: 'api-reference/sdk-react', page: 'ErrorBoundary' },
      ],
    },
    {
      label: 'Angular SDK', id: 'sdk-angular',
      pages: [
        { label: 'PlatformModule', section: 'api-reference/sdk-angular', page: 'PlatformModule' },
        { label: 'HTTP Interceptor', section: 'api-reference/sdk-angular', page: 'PlatformHttpInterceptor' },
        { label: 'Error Handler', section: 'api-reference/sdk-angular', page: 'PlatformErrorHandler' },
        { label: 'Bug Reporter', section: 'api-reference/sdk-angular', page: 'BugReporterComponent' },
      ],
    },
    {
      label: 'Python SDK', id: 'sdk-python',
      pages: [
        { label: 'PlatformClient', section: 'api-reference/sdk-python', page: 'PlatformClient' },
        { label: 'PostgreSQL', section: 'api-reference/sdk-python', page: 'db-postgres' },
        { label: 'MongoDB', section: 'api-reference/sdk-python', page: 'db-mongo' },
        { label: 'Redis', section: 'api-reference/sdk-python', page: 'db-redis' },
      ],
    },
    {
      label: 'Configuration', id: 'configuration',
      pages: [
        { label: 'Environment Variables', section: 'api-reference/configuration', page: 'environment-variables' },
        { label: 'Permissions Matrix', section: 'api-reference/configuration', page: 'permissions' },
        { label: 'Secrets Encryption', section: 'api-reference/configuration', page: 'secrets-encryption' },
      ],
    },
    {
      label: 'Architecture', id: 'architecture',
      pages: [
        { label: 'Overview', section: 'architecture', page: 'overview' },
        { label: 'Data Flow', section: 'architecture', page: 'data-flow' },
        { label: 'Auth Flow', section: 'architecture', page: 'auth-flow' },
        { label: 'SDK Lifecycle', section: 'architecture', page: 'sdk-lifecycle' },
        { label: 'Secrets Architecture', section: 'architecture', page: 'secrets-architecture' },
        { label: 'K8s Infrastructure', section: 'architecture', page: 'k8s-infrastructure' },
        { label: 'Database Schema', section: 'architecture', page: 'database-schema' },
        { label: 'Network Topology', section: 'architecture', page: 'network-topology' },
      ],
    },
    {
      label: 'Deployment', id: 'deployment',
      pages: [
        { label: 'Bootstrap', section: 'deployment', page: 'bootstrap' },
        { label: 'Rebuild & Deploy', section: 'deployment', page: 'rebuild-and-deploy' },
        { label: 'Update Secrets', section: 'deployment', page: 'update-secrets' },
        { label: 'SSL Certificates', section: 'deployment', page: 'ssl-certificates' },
        { label: 'Backup & Restore', section: 'deployment', page: 'backup-and-restore' },
        { label: 'Scaling', section: 'deployment', page: 'scaling' },
      ],
    },
    {
      label: 'Troubleshooting', id: 'troubleshooting',
      pages: [
        // Install & bootstrap
        { label: 'apt lock', section: 'troubleshooting', page: 'apt-lock' },
        { label: 'DNS / IPv6 Timeout', section: 'troubleshooting', page: 'dns-ipv6-timeout' },
        { label: 'General DNS Resolution', section: 'troubleshooting', page: 'general-dns-resolution' },
        { label: 'sslip.io in-cluster DNS', section: 'troubleshooting', page: 'sslip-io-dns' },
        { label: 'k3s port conflict', section: 'troubleshooting', page: 'k3s-port-conflict' },
        { label: 'Docker Hub rate limit', section: 'troubleshooting', page: 'dockerhub-rate-limit' },
        { label: 'Disk pressure', section: 'troubleshooting', page: 'disk-pressure' },
        { label: 'ImagePullBackOff', section: 'troubleshooting', page: 'image-pull-backoff' },
        { label: 'Helm name reuse', section: 'troubleshooting', page: 'helm-name-reuse' },
        { label: 'TypeScript build errors', section: 'troubleshooting', page: 'typescript-build-errors' },
        // Ingress / TLS / auth
        { label: 'cert-manager timeout', section: 'troubleshooting', page: 'cert-manager-timeout' },
        { label: 'Ingress ownership', section: 'troubleshooting', page: 'ingress-ownership' },
        { label: 'Portainer setup token', section: 'troubleshooting', page: 'portainer-setup-token' },
        { label: 'Portainer OIDC SSL', section: 'troubleshooting', page: 'portainer-oidc-ssl' },
        { label: 'ArgoCD subpath 404', section: 'troubleshooting', page: 'argocd-subpath-404' },
        { label: 'ArgoCD OIDC redirect', section: 'troubleshooting', page: 'argocd-oidc-redirect' },
        { label: 'Grafana subpath redirect', section: 'troubleshooting', page: 'grafana-subpath-redirect' },
        // Databases & storage
        { label: 'MinIO template error', section: 'troubleshooting', page: 'minio-template-error' },
        { label: 'MinIO PVC not found', section: 'troubleshooting', page: 'minio-pvc-not-found' },
        { label: 'MongoDB validation', section: 'troubleshooting', page: 'mongodb-validation' },
        { label: 'DB WRONGPASS after rotate', section: 'troubleshooting', page: 'db-wrongpass-after-rotate' },
        { label: 'Infisical DB missing', section: 'troubleshooting', page: 'infisical-db-missing' },
        // API & seed
        { label: 'API seed failure', section: 'troubleshooting', page: 'api-seed-failure' },
        { label: 'Angular @ symbol', section: 'troubleshooting', page: 'angular-template-at-symbol' },
      ],
    },
  ];

  get flatPages(): DocPage[] {
    return this.docSections.flatMap(s => s.pages);
  }

  get filteredSections(): DocSection[] {
    if (!this.searchQuery.trim()) return this.docSections;
    const q = this.searchQuery.toLowerCase();
    return this.docSections
      .map(s => ({
        ...s,
        pages: s.pages.filter(p =>
          p.label.toLowerCase().includes(q) ||
          s.label.toLowerCase().includes(q)
        ),
      }))
      .filter(s => s.pages.length > 0);
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
    mermaid.initialize({
      startOnLoad: false,
      theme: 'dark',
      darkMode: true,
      fontFamily: 'Inter, sans-serif',
      themeVariables: {
        background: '#050505',
        primaryColor: '#111827',
        primaryTextColor: '#f8fafc',
        primaryBorderColor: '#3b82f6',
        lineColor: '#60a5fa',
        secondaryColor: '#0f766e',
        tertiaryColor: '#312e81',
        clusterBkg: '#080808',
        clusterBorder: '#334155',
        edgeLabelBackground: '#050505',
        nodeBorder: '#3b82f6',
        mainBkg: '#111827',
        textColor: '#e5e7eb',
        fontFamily: 'Inter, sans-serif'
      },
      flowchart: {
        curve: 'basis',
        padding: 16,
        nodeSpacing: 54,
        rankSpacing: 72
      },
      sequence: {
        mirrorActors: false,
        actorMargin: 72,
        boxMargin: 12,
        messageMargin: 44
      }
    });
  }

  ngOnInit() {
    this.route.paramMap.subscribe(params => {
      const section = params.get('section');
      const page = params.get('page');

      // Reset scroll on every docs navigation. The router-level
      // scrollPositionRestoration in app.config.ts only fires when the routed
      // component changes; because /docs/:section/:page is a single component,
      // switching between docs pages is a same-component nav and Angular
      // leaves the scroll where it was. Do it by hand.
      this.scrollToTop();

      if (section && page) {
        this.currentSection = section;
        this.currentPage = page;
        this.loadMarkdown(`/docs/${section}/${page}.md`);
      } else if (section) {
        const found = this.flatPages.find(p =>
          p.section === section || p.section.startsWith(section + '/')
        );
        if (found) {
          this.router.navigate(['/docs', found.section, found.page], { replaceUrl: true });
          return;
        }
        this.isLoading = false;
        this.content = null;
      } else {
        this.currentSection = '';
        this.currentPage = '';
        this.loadMarkdown('/docs/index.md');
      }
    });
  }

  private scrollToTop() {
    // Scroll the window; also reset the docs main scroll container if the
    // layout uses one (many docs themes overflow inside a wrapper).
    try { window.scrollTo({ top: 0, left: 0, behavior: 'auto' }); } catch { window.scrollTo(0, 0); }
    const scrollables = this.el.nativeElement.querySelectorAll(
      '.docs-main, .docs-content, .docs-scroll, main'
    );
    scrollables.forEach((n: HTMLElement) => { n.scrollTop = 0; });
  }

  ngAfterViewChecked() {
    if (this.rendering) {
      this.rendering = false;
      this.applySyntaxHighlighting();
      this.addCopyButtons();
      this.renderMermaidDiagrams();
      this.buildToc();
    }
  }

  private applySyntaxHighlighting() {
    const container = this.el.nativeElement.querySelector('.docs-markdown');
    if (!container) return;
    container.querySelectorAll('pre code').forEach((block: unknown) => {
      const el = block as HTMLElement;
      const lang = (el.className.match(/language-(\w+)/) || [])[1];
      if (lang && hljs.getLanguage(lang)) {
        hljs.highlightElement(el);
      } else {
        hljs.highlightElement(el);
      }
    });
    this.enhanceHighlighting(container);
  }

  private enhanceHighlighting(container: HTMLElement) {
    // 1. Bash / Shell Enhancements
    container.querySelectorAll('pre code.language-bash, pre code.language-sh, pre code.language-shell').forEach((block: unknown) => {
      const el = block as HTMLElement;
      let html = el.innerHTML;
      
      // Prompts
      html = html.replace(
        /^(\s*)(\$)\s/gm,
        '$1<span class="terminal-prompt">$2</span> '
      );

      // Common CLI commands highlight.js misses
      const cliCommands = ['docker', 'docker-compose', 'npm', 'git', 'kubectl', 'helm', 'ng', 'python', 'node', 'npx', 'sudo', 'apt', 'apt-get'];
      const cliRegex = new RegExp(`(^|>|\\s)(${cliCommands.join('|')})(?=\\s|$)`, 'gm');
      html = html.replace(cliRegex, '$1<span class="hljs-built_in">$2</span>');
      
      el.innerHTML = html;
    });

    // 2. Python Enhancements
    container.querySelectorAll('pre code.language-python').forEach((block: unknown) => {
      const el = block as HTMLElement;
      let html = el.innerHTML;
      
      // SDK Classes highlight.js misses when instantiated
      const pyClasses = ['MongoClient', 'PostgresPool', 'RedisClient', 'PlatformClient', 'MongoManager', 'PostgresManager', 'RedisManager'];
      const pyRegex = new RegExp(`(^|>|\\s|\\.)(${pyClasses.join('|')})(?=\\s|\\(|$)`, 'g');
      html = html.replace(pyRegex, '$1<span class="hljs-title class_">$2</span>');
      
      el.innerHTML = html;
    });

    // 3. Env file Enhancements
    container.querySelectorAll('pre code.language-env, pre code.language-dotenv, pre code.language-properties').forEach((block: unknown) => {
      const el = block as HTMLElement;
      let html = el.innerHTML;
      
      // Match KEY=value pattern if it's not already inside a span (basic fallback)
      html = html.replace(/^([A-Z0-9_]+)=(.+)$/gm, (match, key, value) => {
        // If hljs already wrapped the whole thing, just replace the inner text
        const cleanKey = key.replace(/<[^>]*>/g, '');
        const cleanVal = value.replace(/<[^>]*>/g, '');
        return `<span class="hljs-attr">${cleanKey}</span>=<span class="hljs-string">${cleanVal}</span>`;
      });
      
      el.innerHTML = html;
    });

    // 4. HTTP request/response blocks
    container.querySelectorAll('pre code.language-http').forEach((block: unknown) => {
      const el = block as HTMLElement;
      let html = el.innerHTML;
      html = html.replace(
        /^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)(\s+)([^ \n]+)(\s+HTTP\/[0-9.]+)/gm,
        '<span class="http-method http-$1">$1</span>$2<span class="http-path">$3</span><span class="http-version">$4</span>'
      );
      html = html.replace(
        /^([A-Za-z0-9-]+):(\s*)(.+)$/gm,
        '<span class="http-header">$1</span>:$2<span class="http-header-value">$3</span>'
      );
      el.innerHTML = html;
    });
  }

  private addCopyButtons() {
    const container = this.el.nativeElement.querySelector('.docs-markdown');
    if (!container) return;
    container.querySelectorAll('pre').forEach((pre: unknown) => {
      const el = pre as HTMLElement;
      if (el.querySelector('.docs-copy-btn')) return;

      const lang = (el.querySelector('code')?.className.match(/language-(\w+)/) || [])[1] || 'code';

      const header = document.createElement('div');
      header.className = 'docs-code-header';

      const langLabel = document.createElement('span');
      langLabel.className = 'docs-code-lang';
      langLabel.textContent = lang;

      const btn = document.createElement('button');
      btn.className = 'docs-copy-btn';
      btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
      btn.title = 'Copy code';

      btn.addEventListener('click', () => {
        const code = el.querySelector('code')?.textContent || '';
        navigator.clipboard.writeText(code).then(() => {
          btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>`;
          btn.classList.add('copied');
          setTimeout(() => {
            btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
            btn.classList.remove('copied');
          }, 2000);
        });
      });

      header.appendChild(langLabel);
      header.appendChild(btn);
      el.insertBefore(header, el.firstChild);
    });
  }

  @HostListener('click', ['$event'])
  onClick(event: MouseEvent) {
    const target = event.target as HTMLElement;
    const anchor = target.closest('a');
    if (!anchor || !anchor.getAttribute('href')) return;
    const href = anchor.getAttribute('href')!;

    if (href.startsWith('/docs/')) {
      event.preventDefault();
      const parts = href.replace('/docs/', '').split('/');
      if (parts.length >= 2) {
        this.router.navigate(['/docs', parts[0], parts[1]]);
      }
    }
  }

  navigateTo(page: DocPage) {
    this.mobileNavOpen = false;
    this.router.navigate(['/docs', page.section, page.page]);
  }

  isActive(page: DocPage): boolean {
    return this.currentSection === page.section && this.currentPage === page.page;
  }

  isSectionActive(section: DocSection): boolean {
    return section.pages.some(p => this.isActive(p));
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

  getBreadcrumbTitle(): string {
    if (!this.currentSection) return 'Overview';
    const found = this.flatPages.find(p => this.isActive(p));
    if (found) return found.label;
    const parts = this.currentSection.split('/');
    return parts[parts.length - 1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  private async loadMarkdown(path: string) {
    this.isLoading = true;
    this.content = null;
    this.http.get(path, { responseType: 'text' })
      .pipe(
        catchError(() => {
          this.isLoading = false;
          this.content = null;
          return of(null);
        })
      )
      .subscribe(async (text) => {
        if (text) {
          try {
            // Rewrite relative `.md` links so they resolve against the CURRENT
            // section, not against the docs root. Before this fix, a link like
            // `[Deployments API](deployments.md)` inside
            // /docs/api-reference/platform-api/projects would render as
            // `/docs/deployments` (404). Now it correctly resolves to
            // `/docs/api-reference/platform-api/deployments`.
            const currentDir = this.currentSection || '';
            const processed = text.replace(
              /\]\((\.{0,2}\/)?([a-zA-Z0-9_\/-]+)\.md(#[a-zA-Z0-9_-]+)?\)/g,
              (_match, prefix: string, path: string, hash: string | undefined) => {
                const hashPart = hash || '';
                // Absolute paths starting with `/` — leave the rewriter alone
                if (prefix === '/') {
                  return `](/${path}${hashPart})`;
                }
                const segs = currentDir.split('/').filter(Boolean);
                if (prefix === '../') {
                  segs.pop();
                  const target = segs.length ? `${segs.join('/')}/${path}` : path;
                  return `](/docs/${target}${hashPart})`;
                }
                if (prefix === '../../') {
                  segs.pop();
                  segs.pop();
                  const target = segs.length ? `${segs.join('/')}/${path}` : path;
                  return `](/docs/${target}${hashPart})`;
                }
                // No prefix (or `./`) — same directory as current doc
                const base = currentDir ? `${currentDir}/` : '';
                return `](/docs/${base}${path}${hashPart})`;
              }
            );
            let html = await marked.parse(processed);
            html = this.enhanceApiDocs(html);
            html = this.enhanceAuthBadges(html);
            html = this.enhanceResponseSections(html);
            html = this.enhanceSectionHeadings(html);
            html = this.transformMermaidBlocks(html);
            this.content = this.sanitizer.bypassSecurityTrustHtml(html as string);
            this.rendering = true;
            this.cdr.detectChanges();
            // Re-scroll after content mounts: the initial scrollToTop in
            // ngOnInit ran when the DOM still had the previous page's
            // content, so a user who scrolled during the async fetch would
            // land mid-page on the new doc otherwise.
            queueMicrotask(() => this.scrollToTop());
          } catch (e) {
            console.error('Error parsing markdown', e);
          }
        }
        this.isLoading = false;
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
        out.push(`<div class="api-card"><div class="api-card-header"><span class="api-method method-${m[1].toLowerCase()}">${m[1]}</span><code class="api-path">${m[2].trim()} <span class="api-http-version">HTTP/1.1</span></code></div><div class="api-card-body">`);
        cardOpen = true;
      } else {
        out.push(part);
      }
    }
    if (cardOpen) { out.push('</div></div>'); }

    let result = out.join('');

    result = result.replace(
      /<h3[^>]*>\s*<code>(GET|POST|PUT|PATCH|DELETE)<\/code>\s+(.+?)<\/h3>/gi,
      '<div class="api-sub-card"><div class="api-card-header method-sub"><span class="api-method method-$1">$1</span><code class="api-path">$2 <span class="api-http-version">HTTP/1.1</span></code></div></div>'
    );

    return result;
  }

  private enhanceAuthBadges(html: string): string {
    return html.replace(
      /<p><strong>Auth:<\/strong>\s*(.*?)<\/p>/gi,
      (_m, text: string) => {
        const isNone = /none/i.test(text);
        const cls = isNone ? 'auth-none' : 'auth-required';
        return `<p class="auth-row"><span class="api-auth-badge ${cls}">${isNone ? '🔓 No Auth Required' : `🔑 ${text.trim()}`}</span></p>`;
      }
    );
  }

  private enhanceResponseSections(html: string): string {
    return html
      .replace(
        /<p><strong>Response\s+`(\d+)`:<\/strong><\/p>/gi,
        '<div class="api-sub-header"><span class="response-badge">$1</span><span>Response</span></div>'
      )
      .replace(
        /<p><strong>Request Body:<\/strong><\/p>/gi,
        '<div class="api-sub-header"><span class="request-icon">📦</span><span>Request Body</span></div>'
      )
      .replace(
        /<p><strong>Query Parameters:<\/strong><\/p>/gi,
        '<div class="api-sub-header"><span class="request-icon">🔍</span><span>Query Parameters</span></div>'
      )
      .replace(
        /<p><strong>Error\s+`(\d+)`:<\/strong><\/p>/gi,
        '<div class="api-sub-header"><span class="response-badge error-badge">$1</span><span>Error Response</span></div>'
      );
  }

  private transformMermaidBlocks(html: string): string {
    return html.replace(
      /<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/gi,
      (_m, code: string) => {
        const decoded = code
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/&#x27;/g, "'")
          .replace(/&#x2F;/g, '/')
          .trim();
        return `<div class="mermaid">${decoded}</div>`;
      }
    );
  }

  scrollToHeading(event: Event, id: string) {
    event.preventDefault();
    const el = document.getElementById(id);
    if (el) {
      const offset = 100;
      const top = el.getBoundingClientRect().top + window.scrollY - offset;
      window.scrollTo({ top, behavior: 'smooth' });
    }
  }

  private buildToc() {
    this.tocItems = [];
    this.activeTocId = '';
    this.disconnectTocObserver();
    const container = this.el.nativeElement.querySelector('.docs-markdown');
    if (!container) return;
    const headings = container.querySelectorAll('h2, h3');
    if (headings.length === 0) return;

    headings.forEach((h: Element) => {
      const el = h as HTMLElement;
      let id = el.id || el.textContent?.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') || '';
      if (!el.id) { el.id = id; }
      this.tocItems.push({ id, text: el.textContent || '', level: el.tagName.toLowerCase() });
    });

    this.tocObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            this.activeTocId = entry.target.id;
            this.cdr.detectChanges();
          }
        }
      },
      { rootMargin: '-80px 0px -70% 0px', threshold: 0 }
    );

    setTimeout(() => {
      headings.forEach((h: Element) => {
        const el = h as HTMLElement;
        if (el.id) this.tocObserver?.observe(el);
      });
    }, 100);
  }

  private disconnectTocObserver() {
    if (this.tocObserver) {
      this.tocObserver.disconnect();
      this.tocObserver = null;
    }
  }

  private async renderMermaidDiagrams() {
    const container = this.el.nativeElement.querySelector('.docs-markdown');
    if (!container) return;
    const mermaidNodes = container.querySelectorAll('.mermaid:not([data-processed])') as NodeListOf<HTMLElement>;
    if (mermaidNodes.length === 0) {
      this.enhanceDiagramViewers();
      return;
    }
    // Render each block one at a time so a single broken diagram doesn't
    // silently kill every diagram after it. On failure, replace the block
    // with a visible error message + the original source so the user (and
    // future us) can see what went wrong instead of staring at a blank spot.
    for (const node of Array.from(mermaidNodes)) {
      const original = node.textContent || '';
      try {
        await mermaid.run({ nodes: [node] });
      } catch (e: any) {
        console.error('Mermaid render error:', e);
        node.setAttribute('data-processed', 'true');
        node.classList.add('mermaid-error');
        node.innerHTML = `
          <div style="padding:14px 16px;border:1px solid #b91c1c;background:#1f0a0a;border-radius:8px;color:#fecaca;font-size:0.85rem;">
            <div style="font-weight:600;color:#fca5a5;margin-bottom:6px;">Diagram failed to render</div>
            <div style="font-size:0.78rem;opacity:0.9;margin-bottom:8px;">${(e?.message || e || 'Mermaid parse error').toString().replace(/</g,'&lt;')}</div>
            <pre style="margin:0;padding:10px 12px;background:#0b0f19;border-radius:6px;color:#f1f5f9;font-size:0.78rem;overflow-x:auto;">${original.replace(/</g,'&lt;')}</pre>
          </div>`;
      }
    }
    this.enhanceDiagramViewers();
  }

  private enhanceDiagramViewers() {
    const container = this.el.nativeElement.querySelector('.docs-markdown') as HTMLElement | null;
    if (!container) return;

    const diagramNodes = Array.from(container.querySelectorAll<HTMLElement>('.mermaid, pre')).filter((node) => {
      if (node.closest('.docs-diagram-viewer')) return false;
      if (node.classList.contains('mermaid')) return true;
      const text = node.textContent || '';
      return /[┌┐└┘├┤┬┴│─→←↔▼▲►]/.test(text);
    });

    diagramNodes.forEach((node) => {
      const isMermaid = node.classList.contains('mermaid');
      const viewer = document.createElement('div');
      viewer.className = `docs-diagram-viewer ${isMermaid ? 'docs-mermaid-viewer' : 'docs-ascii-viewer'}`;

      const toolbar = document.createElement('div');
      toolbar.className = 'docs-diagram-toolbar';

      const title = document.createElement('span');
      title.className = 'docs-diagram-title';
      title.textContent = isMermaid ? 'Interactive diagram' : 'Interactive legacy diagram';

      const controls = document.createElement('div');
      controls.className = 'docs-diagram-controls';

      const canvas = document.createElement('div');
      canvas.className = 'docs-diagram-canvas';

      const viewport = document.createElement('div');
      viewport.className = 'docs-diagram-viewport';

      node.parentNode?.insertBefore(viewer, node);
      viewport.appendChild(node);
      canvas.appendChild(viewport);

      let scale = 1;
      let translateX = 0;
      let translateY = 0;
      let isDragging = false;
      let dragStartX = 0;
      let dragStartY = 0;

      const applyTransform = () => {
        viewport.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
      };

      const fitToCanvas = () => {
        const content = (node.querySelector('svg') || node.querySelector('code') || node) as HTMLElement;
        const contentWidth = content.getBoundingClientRect().width || content.scrollWidth || 1;
        const availableWidth = Math.max(canvas.clientWidth - 12, 320);
        scale = Math.min(1, Math.max(0.54, Number((availableWidth / contentWidth).toFixed(2))));
        translateX = 0;
        translateY = 0;
        applyTransform();
      };

      const makeButton = (label: string, action: () => void) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'docs-diagram-btn';
        btn.textContent = label;
        btn.addEventListener('click', action);
        return btn;
      };

      controls.appendChild(makeButton('-', () => {
        scale = Math.max(0.5, Number((scale - 0.1).toFixed(2)));
        applyTransform();
      }));
      controls.appendChild(makeButton('+', () => {
        scale = Math.min(1.8, Number((scale + 0.1).toFixed(2)));
        applyTransform();
      }));
      controls.appendChild(makeButton('Reset', () => {
        fitToCanvas();
      }));

      canvas.addEventListener('pointerdown', (event) => {
        isDragging = true;
        dragStartX = event.clientX - translateX;
        dragStartY = event.clientY - translateY;
        canvas.setPointerCapture(event.pointerId);
        canvas.classList.add('is-panning');
      });

      canvas.addEventListener('pointermove', (event) => {
        if (!isDragging) return;
        translateX = event.clientX - dragStartX;
        translateY = event.clientY - dragStartY;
        applyTransform();
      });

      const stopDragging = (event: PointerEvent) => {
        isDragging = false;
        canvas.releasePointerCapture(event.pointerId);
        canvas.classList.remove('is-panning');
      };

      canvas.addEventListener('pointerup', stopDragging);
      canvas.addEventListener('pointercancel', stopDragging);
      canvas.addEventListener('wheel', (event) => {
        event.preventDefault();
        if (event.ctrlKey) {
          scale = Math.min(1.8, Math.max(0.5, Number((scale + (event.deltaY > 0 ? -0.08 : 0.08)).toFixed(2))));
        } else {
          translateX -= event.deltaX;
          translateY -= event.deltaY;
        }
        applyTransform();
      }, { passive: false });

      toolbar.appendChild(title);
      toolbar.appendChild(controls);
      viewer.appendChild(toolbar);
      viewer.appendChild(canvas);
      requestAnimationFrame(fitToCanvas);
    });
  }

  private enhanceSectionHeadings(html: string): string {
    return html
      .replace(
        /<h2[^>]*>Roles CRUD<\/h2>/gi,
        '<h2 class="api-section-title">Roles CRUD</h2>'
      )
      .replace(
        /<h2[^>]*>Permission Validation<\/h2>/gi,
        '<h2 class="api-section-title">Permission Validation</h2>'
      )
      .replace(
        /<h2[^>]*>Error Codes<\/h2>/gi,
        '<h2 class="api-section-title">Error Codes</h2>'
      );
  }
}
