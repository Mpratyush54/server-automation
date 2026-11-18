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
            Cairn turns one or more Ubuntu servers into a place where your team deploys apps, gets databases,
            keeps backups and sees everything run, without stitching tools together by hand and without handing your data to a host.
          </p>
        </div>
      </section>

      <section class="ab-section">
        <div class="ab-frame">
          <h2 class="ab-h2">Why it exists</h2>
          <div class="ab-compare">
            <div class="ab-card"><span class="ab-tag">Hosted platforms</span><p>Easy to deploy, but you rent their servers, your data lives with them and the bill grows with every app.</p></div>
            <div class="ab-card"><span class="ab-tag">Doing it yourself</span><p>You keep control and cost, but every team becomes an operations team: Kubernetes, certificates, databases, backups, alerts.</p></div>
            <div class="ab-card ab-card-on"><span class="ab-tag">Cairn</span><p>Does that setup once, the same way every time, on servers you own. Developers get one place to deploy, operators one place to watch.</p></div>
          </div>
        </div>
      </section>

      <section class="ab-section">
        <div class="ab-frame">
          <h2 class="ab-h2">What you get</h2>
          <ul class="ab-grid">
            <li><b>Deploy from Git</b><span>Connect a repository, deploy to development, staging or production.</span></li>
            <li><b>Databases</b><span>PostgreSQL, MongoDB and Redis, with credentials delivered to your app.</span></li>
            <li><b>Monitoring</b><span>Metrics, logs, traces, errors and alerts in one portal.</span></li>
            <li><b>Backups</b><span>Encrypted backups to a bucket you choose, with restore tests.</span></li>
            <li><b>High availability</b><span>Three servers keep apps and databases running when one fails.</span></li>
            <li><b>AI agents</b><span>Assistants read status and request changes through MCP, with human approval.</span></li>
          </ul>
        </div>
      </section>

      <section class="ab-section">
        <div class="ab-frame">
          <h2 class="ab-h2">What we hold ourselves to</h2>
          <ul class="ab-grid">
            <li><b>Your servers, your data.</b><span>Everything runs on machines you control.</span></li>
            <li><b>Useful on one server.</b><span>One machine is a complete install; more servers add high availability.</span></li>
            <li><b>Proven parts.</b><span>Kubernetes, PostgreSQL, Grafana and other widely used tools, not reinvented.</span></li>
            <li><b>Safe by default.</b><span>Two-factor sign-in, roles, an audit log and a firewall from the first install.</span></li>
            <li><b>Recoverable.</b><span>Failover is tested by switching servers off under load.</span></li>
            <li><b>Open.</b><span>Roadmap, releases and issues are public on GitHub.</span></li>
          </ul>
        </div>
      </section>

      <section class="ab-section">
        <div class="ab-frame">
          <h2 class="ab-h2">How it is built</h2>
          <dl class="ab-parts">
            <div><dt>platformctl</dt><dd>Command-line tool that installs, joins, upgrades, backs up and restores servers.</dd></div>
            <div><dt>API</dt><dd>Manages projects, deployments, databases, users and alerts.</dd></div>
            <div><dt>Portal</dt><dd>The web dashboard for developers and operators.</dd></div>
            <div><dt>SDKs</dt><dd>Node.js, React, Angular and Python libraries for credentials and telemetry.</dd></div>
            <div><dt>MCP server</dt><dd>Gives AI assistants scoped, approved access.</dd></div>
          </dl>
        </div>
      </section>

      <section class="ab-section">
        <div class="ab-frame ab-end">
          <p><b>Free for personal use.</b> Companies can evaluate for 60 days; Enterprise is priced per server.</p>
          <div class="ab-links">
            <a class="btn btn-primary" routerLink="/docs/getting-started/installation">Install</a>
            <a class="btn" routerLink="/pricing">Pricing</a>
            <a class="btn" href="https://github.com/Mpratyush54/server-automation" target="_blank" rel="noopener">GitHub</a>
            <a class="btn" routerLink="/docs/contribution-guide">Contribute</a>
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
    .ab-compare { display: grid; gap: 12px; }
    @media (min-width: 860px) { .ab-compare { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; } }
    .ab-card { border: 1px solid rgb(var(--line)); border-radius: 10px; padding: 1rem 1.1rem; background: rgb(var(--surface, var(--canvas))); }
    .ab-card p { margin: 0.4rem 0 0; line-height: 1.55; color: rgb(var(--fg-2)); }
    .ab-card-on { border-color: rgb(var(--accent)); }
    .ab-tag { font-size: 0.8rem; font-weight: 600; letter-spacing: 0.02em; color: rgb(var(--fg)); }
    .ab-card-on .ab-tag { color: rgb(var(--accent)); }
    .ab-grid { list-style: none; margin: 0; padding: 0; display: grid; gap: 14px 24px; }
    @media (min-width: 640px) { .ab-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    @media (min-width: 960px) { .ab-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
    .ab-grid li { padding-left: 1rem; border-left: 2px solid rgb(var(--line-strong)); line-height: 1.55; }
    .ab-grid b { display: block; font-weight: 600; color: rgb(var(--fg)); }
    .ab-grid span { color: rgb(var(--fg-2)); }
    .ab-parts { margin: 0; display: grid; gap: 10px 24px; }
    @media (min-width: 760px) { .ab-parts { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    .ab-parts div { display: grid; grid-template-columns: 7.5rem 1fr; gap: 12px; align-items: baseline; }
    .ab-parts dt { font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 0.85rem; color: rgb(var(--fg)); }
    .ab-parts dd { margin: 0; color: rgb(var(--fg-2)); line-height: 1.55; }
    .ab-end { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 16px; }
    .ab-end p { margin: 0; color: rgb(var(--fg-2)); line-height: 1.6; }
    .ab-links { display: flex; flex-wrap: wrap; gap: 0.6rem; }
  `],
})
export class AboutComponent {}
