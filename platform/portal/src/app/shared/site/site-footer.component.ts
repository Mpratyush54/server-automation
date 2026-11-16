import { Component } from '@angular/core';
import { RouterModule } from '@angular/router';

/** Footer for the public site. */
@Component({
  selector: 'app-site-footer',
  standalone: true,
  imports: [RouterModule],
  template: `
    <footer class="sf">
      <div class="sf-inner">
        <div class="sf-brand">
          <strong>Cairn</strong>
          <p>Self-hosted deployment, databases, backups and monitoring for your own servers. Source code on GitHub.</p>
        </div>
        <nav class="sf-cols" aria-label="Footer">
          <div>
            <span>Product</span>
            <a routerLink="/" fragment="product">Features</a>
            <a routerLink="/" fragment="high-availability">High availability</a>
            <a routerLink="/docs/getting-started/installation">Install</a>
            <a routerLink="/pricing">Pricing</a>
          </div>
          <div>
            <span>Learn</span>
            <a routerLink="/docs">Documentation</a>
            <a routerLink="/docs/faq">FAQ</a>
            <a href="https://github.com/Mpratyush54/server-automation/releases" target="_blank" rel="noopener">Releases</a>
          </div>
          <div>
            <span>Project</span>
            <a routerLink="/about">About</a>
            <a href="https://github.com/Mpratyush54/server-automation" target="_blank" rel="noopener">GitHub</a>
            <a routerLink="/docs/contribution-guide">Contribute</a>
          </div>
        </nav>
      </div>
      <div class="sf-base">
        <span>Runs on infrastructure you control.</span>
      </div>
    </footer>
  `,
  styles: [`
    .sf { border-top: 1px solid rgb(var(--line)); background: rgb(var(--surface)); }
    .sf-inner { max-width: 72rem; margin: 0 auto; padding-block: 3rem 2rem; display: grid; gap: 2rem;
      padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); }
    @media (min-width: 800px) { .sf-inner { grid-template-columns: 1fr 1.4fr; } }
    .sf-brand strong { font-size: 1rem; color: rgb(var(--fg)); }
    .sf-brand p { margin: 0.5rem 0 0; max-width: 34ch; color: rgb(var(--fg-2)); font-size: 0.875rem; }
    .sf-cols { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1.5rem; }
    .sf-cols div { display: flex; flex-direction: column; gap: 0.5rem; }
    .sf-cols span { font-size: 0.8rem; color: rgb(var(--fg-3)); margin-bottom: 0.25rem; }
    .sf-cols a { color: rgb(var(--fg-2)); text-decoration: none; font-size: 0.875rem; }
    .sf-cols a:hover { color: rgb(var(--fg)); }
    .sf-base { max-width: 72rem; margin: 0 auto; padding-block: 1rem 2rem; color: rgb(var(--fg-3)); font-size: 0.8rem; border-top: 1px solid rgb(var(--line));
      padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); }
  `],
})
export class SiteFooterComponent {}
