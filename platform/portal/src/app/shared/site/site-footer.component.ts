import { Component } from '@angular/core';
import { RouterModule } from '@angular/router';
import { CairnMarkComponent } from './cairn-mark.component';

/**
 * Footer for the public site: compact link columns, then the oversized
 * CAIRN wordmark with the mark balanced on the I. The wordmark layer is
 * decorative (aria-hidden); the brand name above it is the readable text.
 */
@Component({
  selector: 'app-site-footer',
  standalone: true,
  imports: [RouterModule, CairnMarkComponent],
  template: `
    <footer class="sf">
      <div class="sf-inner">
        <div class="sf-top">
          <div class="sf-brand">
            <strong>Cairn</strong>
            <p>Self-hosted deployment, databases, backups and monitoring for your own servers.</p>
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

        <div class="sf-hero" aria-hidden="true">
          <div class="sf-word">
            <span>C</span><span>A</span><span class="sf-i">I<app-cairn-mark class="sf-perch"></app-cairn-mark></span><span>R</span><span>N</span>
            <span class="sf-script">your servers</span>
          </div>
        </div>
      </div>
    </footer>
  `,
  styles: [`
    .sf { border-top: 1px solid rgb(var(--line)); background: rgb(var(--surface)); color: rgb(var(--fg)); overflow: hidden; }
    .sf-inner { max-width: 72rem; margin: 0 auto;
      padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); }

    .sf-top { display: grid; gap: 1.75rem; padding-block: 2.5rem 0; }
    @media (min-width: 800px) { .sf-top { grid-template-columns: 1fr 1.3fr; } }
    .sf-brand strong { font-size: 1rem; font-weight: 600; }
    .sf-brand p { margin: 0.4rem 0 0; max-width: 36ch; color: rgb(var(--fg-2)); font-size: 0.875rem; line-height: 1.55; }
    .sf-cols { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1.25rem; }
    .sf-cols div { display: flex; flex-direction: column; gap: 0.45rem; min-width: 0; }
    .sf-cols span { font-size: 0.75rem; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: rgb(var(--fg-3)); margin-bottom: 0.2rem; }
    .sf-cols a { color: rgb(var(--fg-2)); text-decoration: none; font-size: 0.875rem; }
    .sf-cols a:hover { color: rgb(var(--fg)); }
    .sf a:focus-visible { outline: 2px solid rgb(var(--focus)); outline-offset: 2px; border-radius: 2px; }

    /* The wordmark fills the content width: sizes are in container units, so
       it scales with the frame from 390px phones to the 72rem desktop width. */
    .sf-hero { container-type: inline-size; margin-top: clamp(1.25rem, 3vw, 2rem); padding-bottom: clamp(1.5rem, 4vw, 3rem); }
    .sf-word { position: relative; display: flex; justify-content: space-between; align-items: flex-end;
      font-size: 32.4cqi; font-weight: 700; line-height: 0.74; letter-spacing: -0.02em;
      padding-top: 0.34em; user-select: none; }
    .sf-word > span:not(.sf-script) { display: block; }
    .sf-i { position: relative; }
    /* The mark sits on the I's flat top, like stones stacked on a post. */
    .sf-perch { position: absolute; left: 50%; bottom: 0.652em; width: 0.36em; height: 0.36em;
      translate: -50% 0; transform-origin: 50% 88%; color: rgb(var(--fg)); }
    .sf-word:hover .sf-perch { animation: sf-wobble 0.9s ease-in-out; }
    @keyframes sf-wobble { 0%, 100% { rotate: 0deg; } 25% { rotate: -6deg; } 55% { rotate: 4deg; } 80% { rotate: -1.5deg; } }
    @media (prefers-reduced-motion: reduce) { .sf-word:hover .sf-perch { animation: none; } }

    /* Handwritten accent across the R and N, cut out of the letters by a halo
       in the footer colour so it stays legible where they overlap. */
    .sf-script { position: absolute; right: 0; bottom: 0.26em; font-family: 'Caveat', 'Segoe Print', cursive;
      font-size: 0.27em; font-weight: 700; line-height: 1; letter-spacing: 0; color: rgb(var(--accent-text));
      transform: rotate(-7deg); transform-origin: 100% 100%; white-space: nowrap;
      text-shadow: 0 0 0.06em rgb(var(--surface)), 0.04em 0.04em 0 rgb(var(--surface)), -0.04em -0.04em 0 rgb(var(--surface)),
        0.04em -0.04em 0 rgb(var(--surface)), -0.04em 0.04em 0 rgb(var(--surface)), 0.06em 0 0 rgb(var(--surface)), -0.06em 0 0 rgb(var(--surface)),
        0 0.06em 0 rgb(var(--surface)), 0 -0.06em 0 rgb(var(--surface)); }

  `],
})
export class SiteFooterComponent {}
