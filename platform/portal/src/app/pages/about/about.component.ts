import { Component } from '@angular/core';
import { RouterModule } from '@angular/router';
import { SiteHeaderComponent } from '../../shared/site/site-header.component';
import { SiteFooterComponent } from '../../shared/site/site-footer.component';

/** Public About page (#187). */
@Component({
  selector: 'app-about',
  standalone: true,
  imports: [RouterModule, SiteHeaderComponent, SiteFooterComponent],
  template: `
    <app-site-header current="about"></app-site-header>
    <main class="ab" id="main">
      <section class="ab-hero">
        <div class="ab-frame">
          <h1 class="ab-display"><span>A platform for teams</span> <span class="ab-quiet">that run their own servers.</span></h1>
          <p class="ab-lede">
            Cairn installs and connects the tools a team needs to deploy and run apps on Ubuntu servers you control,
            so you get the ease of a hosted platform without handing over your data.
          </p>
        </div>
      </section>

      <section class="ab-section">
        <div class="ab-frame">
          <h2 class="ab-h2">What we hold ourselves to</h2>
          <ul class="ab-principles">
            <li><b>Your servers, your data.</b> Everything runs on machines you control, and backups go to a bucket you choose.</li>
            <li><b>Useful on one server.</b> One machine is a complete install. Three add high availability, not a different product.</li>
            <li><b>Proven parts.</b> Kubernetes, PostgreSQL, Grafana and other widely used open-source tools, set up well, not reinvented.</li>
          </ul>
        </div>
      </section>

      <section class="ab-section">
        <div class="ab-frame ab-end">
          <p>Developed in the open. Releases, roadmap and issues are on GitHub.</p>
          <div class="ab-links">
            <a class="btn btn-primary" href="https://github.com/Mpratyush54/server-automation" target="_blank" rel="noopener">View on GitHub</a>
            <a class="btn" routerLink="/docs/contribution-guide">Contribution guide</a>
            <a class="btn" routerLink="/docs/getting-started/installation">Install</a>
          </div>
        </div>
      </section>
    </main>
    <app-site-footer></app-site-footer>
  `,
  styles: [`
    :host { display: block; }
    .ab { background: rgb(var(--canvas)); color: rgb(var(--fg)); }
    .ab-frame { max-width: 72rem; margin: 0 auto; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); }
    .ab-hero { border-bottom: 1px solid rgb(var(--line));
      background-image: linear-gradient(rgb(var(--line) / 0.4) 1px, transparent 1px), linear-gradient(90deg, rgb(var(--line) / 0.4) 1px, transparent 1px);
      background-size: 48px 48px; }
    .ab-hero .ab-frame { padding-block: clamp(2.5rem, 6vw, 4.5rem); }
    .ab-display { margin: 0; font-size: clamp(2.1rem, 4.6vw, 3.2rem); line-height: 1.06; font-weight: 600; letter-spacing: -0.025em; max-width: 22ch; }
    .ab-display span { display: block; }
    .ab-quiet { color: rgb(var(--fg-3)); }
    .ab-lede { margin: 1.25rem 0 0; max-width: 60ch; font-size: 1.0625rem; line-height: 1.6; color: rgb(var(--fg-2)); }
    .ab-section { border-bottom: 1px solid rgb(var(--line)); }
    .ab-section .ab-frame { padding-block: clamp(2.5rem, 5vw, 3.5rem); }
    .ab-h2 { margin: 0 0 1.25rem; font-size: 1.35rem; font-weight: 600; letter-spacing: -0.015em; }
    .ab-principles { list-style: none; margin: 0; padding: 0; display: grid; gap: 16px; }
    @media (min-width: 860px) { .ab-principles { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 24px; } }
    .ab-principles li { line-height: 1.6; color: rgb(var(--fg-2)); padding-left: 1rem; border-left: 2px solid rgb(var(--line-strong)); }
    .ab-principles b { display: block; color: rgb(var(--fg)); font-weight: 600; }
    .ab-end { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 16px; }
    .ab-end p { margin: 0; color: rgb(var(--fg-2)); line-height: 1.6; }
    .ab-links { display: flex; flex-wrap: wrap; gap: 0.6rem; }
  `],
})
export class AboutComponent {}
