import { Component, Input, inject } from '@angular/core';
import { RouterModule } from '@angular/router';
import { ThemeService } from '../../services/theme.service';

/** Header for the public site (landing, About, docs links). */
@Component({
  selector: 'app-site-header',
  standalone: true,
  imports: [RouterModule],
  template: `
    <header class="sh">
      <div class="sh-inner">
        <a routerLink="/" class="sh-brand" aria-label="Cairn home">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="3" y="4" width="18" height="4.5" rx="1.2"></rect>
            <rect x="3" y="10" width="18" height="4.5" rx="1.2"></rect>
            <rect x="3" y="16" width="18" height="4.5" rx="1.2"></rect>
            <circle cx="6.5" cy="12.25" r="1.1"></circle>
          </svg>
          <span>Cairn</span>
        </a>
        <nav class="sh-nav" aria-label="Site">
          <a routerLink="/" fragment="product" [class.on]="current === 'home'">Product</a>
          <a routerLink="/pricing" [class.on]="current === 'pricing'">Pricing</a>
          <a routerLink="/docs">Docs</a>
          <a routerLink="/about" [class.on]="current === 'about'">About</a>
        </nav>
        <div class="sh-actions">
          <button type="button" class="sh-theme" (click)="theme.cycle()" [attr.aria-label]="'Theme: ' + theme.choice()" [attr.title]="'Theme: ' + theme.choice()">
            @switch (theme.choice()) {
              @case ('light') { <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"></path></svg> }
              @case ('dark') { <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg> }
              @default { <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="4" width="20" height="13" rx="2"></rect><path d="M8 21h8M12 17v4"></path></svg> }
            }
          </button>
          <a class="sh-account" routerLink="/account">Account</a>
          <a class="btn btn-primary btn-sm" routerLink="/docs/getting-started/installation">Install</a>
          <button type="button" class="sh-menu" (click)="menuOpen = !menuOpen" [attr.aria-expanded]="menuOpen" aria-controls="sh-mobile" aria-label="Menu">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="menuOpen ? 'M6 6l12 12M18 6L6 18' : 'M4 7h16M4 12h16M4 17h16'"></path></svg>
          </button>
        </div>
      </div>
      @if (menuOpen) {
        <nav id="sh-mobile" class="sh-mobile" aria-label="Site" (click)="menuOpen = false">
          <a routerLink="/" fragment="product">Product</a>
          <a routerLink="/pricing">Pricing</a>
          <a routerLink="/docs">Docs</a>
          <a routerLink="/about">About</a>
          <a routerLink="/account">Account</a>
        </nav>
      }
    </header>
  `,
  styles: [`
    .sh { position: sticky; top: env(safe-area-inset-top, 0px); z-index: 20; background: rgb(var(--canvas)); border-bottom: 1px solid rgb(var(--line)); }
    .sh-inner { max-width: 72rem; margin: 0 auto; height: 3.5rem; display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 1rem;
      padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); }
    .sh-brand { display: inline-flex; align-items: center; gap: 0.55rem; color: rgb(var(--fg)); text-decoration: none; font-weight: 600; letter-spacing: -0.01em; }
    .sh-brand svg { width: 22px; height: 22px; }
    .sh-brand rect { fill: none; stroke: currentColor; stroke-width: 1.6; }
    .sh-brand circle { fill: rgb(var(--accent)); }
    .sh-brand { justify-self: start; }
    .sh-nav { display: none; gap: 0.25rem; justify-self: center; }
    @media (min-width: 720px) {
      .sh-inner { grid-template-columns: 1fr auto 1fr; }
      .sh-nav { display: flex; }
    }
    .sh-nav a { padding: 0.35rem 0.7rem; border-radius: 999px; font-size: 0.875rem; color: rgb(var(--fg-2)); text-decoration: none; }
    .sh-nav a:hover, .sh-nav a.on { color: rgb(var(--fg)); background: rgb(var(--raised)); }
    .sh-actions { justify-self: end; display: flex; align-items: center; gap: 0.5rem; }
    .sh-account { display: none; font-size: 0.875rem; color: rgb(var(--fg-2)); text-decoration: none; padding: 0.35rem 0.5rem; }
    .sh-account:hover { color: rgb(var(--fg)); }
    @media (min-width: 720px) { .sh-account { display: inline-flex; } }
    .sh-theme { display: inline-flex; align-items: center; justify-content: center; width: 2rem; height: 2rem; border: 0; border-radius: 6px; background: transparent; color: rgb(var(--fg-2)); cursor: pointer; }
    .sh-theme:hover { background: rgb(var(--raised)); color: rgb(var(--fg)); }
    .sh-menu { display: inline-flex; align-items: center; justify-content: center; width: 2rem; height: 2rem; border: 0; border-radius: 6px; background: transparent; color: rgb(var(--fg)); cursor: pointer; }
    .sh-menu svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; }
    @media (min-width: 720px) { .sh-menu, .sh-mobile { display: none !important; } }
    .sh-mobile { display: flex; flex-direction: column; padding: 0.5rem max(16px, env(safe-area-inset-right, 0px)) 0.75rem max(16px, env(safe-area-inset-left, 0px)); border-top: 1px solid rgb(var(--line)); }
    .sh-mobile a { padding: 0.65rem 0; color: rgb(var(--fg)); text-decoration: none; border-bottom: 1px solid rgb(var(--line)); }
    .sh-mobile a:last-child { border-bottom: 0; }
    .sh-theme svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  `],
})
export class SiteHeaderComponent {
  /** Which nav entry to mark as current. */
  @Input() current: 'home' | 'about' | 'pricing' | '' = '';
  readonly theme = inject(ThemeService);
  menuOpen = false;
}
