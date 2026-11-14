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
            Platform turns one or more Ubuntu servers into a place where your team deploys apps, gets databases,
            keeps backups and watches everything run, without stitching a dozen tools together by hand and without
            handing your data to a hosting company.
          </p>
        </div>
      </section>

      <section class="ab-section">
        <div class="ab-frame ab-two">
          <h2>Why it exists</h2>
          <div class="ab-prose">
            <p>Hosted platforms make deploying easy, but you rent their servers, your data lives with them and the bill grows with every app. Running your own servers keeps control and cost in your hands, but turns every team into an operations team: Kubernetes, ingress, certificates, databases, backups, logs, metrics and alerts each need setting up, connecting and keeping alive.</p>
            <p>Platform does that work once, the same way every time. You bring the servers; it installs and connects proven open-source tools, and gives developers one place to deploy and operators one place to see what is happening.</p>
          </div>
        </div>
      </section>

      <section class="ab-section">
        <div class="ab-frame ab-two">
          <h2>What we hold ourselves to</h2>
          <ul class="ab-principles">
            <li><b>Your servers, your data.</b> Everything runs on machines you control. Backups go to storage you choose.</li>
            <li><b>Useful on one server.</b> A single machine is a complete install. More servers add high availability, not a different product.</li>
            <li><b>Proven parts.</b> Kubernetes, PostgreSQL, Grafana and the rest: widely used tools, configured well, not reinvented.</li>
            <li><b>Safe by default.</b> Two-factor sign-in, roles, an audit log, a firewall and automatic security updates from the first install.</li>
            <li><b>Recoverable.</b> High availability is tested by switching servers off under load and checking that no confirmed data is lost.</li>
          </ul>
        </div>
      </section>

      <section class="ab-section">
        <div class="ab-frame ab-two">
          <h2>How it is built</h2>
          <dl class="ab-parts">
            <dt>platformctl</dt><dd>A Go command-line tool that provisions servers, joins them into a cluster, upgrades, backs up and restores.</dd>
            <dt>Platform API</dt><dd>A Node.js service that manages projects, deployments, databases, users, alerts and the SDK endpoints.</dd>
            <dt>Portal</dt><dd>The web dashboard for developers and operators, built with Angular.</dd>
            <dt>SDKs</dt><dd>Libraries for Node.js, React, Angular and Python that deliver database credentials, logs, metrics, errors and browser telemetry.</dd>
            <dt>MCP server</dt><dd>Lets AI coding assistants read status and request changes with scoped tokens and human approval.</dd>
          </dl>
        </div>
      </section>

      <section class="ab-section">
        <div class="ab-frame ab-two">
          <h2>Get involved</h2>
          <div class="ab-prose">
            <p>Platform is developed in the open. The roadmap, releases and discussions live on GitHub; bug reports and ideas are welcome there.</p>
            <div class="ab-links">
              <a class="btn btn-primary" href="https://github.com/Mpratyush54/server-automation" target="_blank" rel="noopener">View on GitHub</a>
              <a class="btn" routerLink="/docs/contribution-guide">Contribution guide</a>
              <a class="btn" href="https://github.com/Mpratyush54/server-automation/issues/new" target="_blank" rel="noopener">Report an issue</a>
            </div>
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
    .ab-hero .ab-frame { padding-block: clamp(3rem, 7vw, 5.5rem); }
    .ab-display { margin: 0; font-size: clamp(2.1rem, 4.6vw, 3.2rem); line-height: 1.06; font-weight: 600; letter-spacing: -0.025em; max-width: 18ch; }
    .ab-display span { display: block; }
    .ab-quiet { color: rgb(var(--fg-3)); }
    .ab-lede { margin: 1.25rem 0 0; max-width: 60ch; font-size: 1.0625rem; line-height: 1.6; color: rgb(var(--fg-2)); }
    .ab-section { border-bottom: 1px solid rgb(var(--line)); }
    .ab-section .ab-frame { padding-block: clamp(2.5rem, 5vw, 4rem); }
    .ab-two { display: grid; gap: 1.25rem; }
    @media (min-width: 860px) { .ab-two { grid-template-columns: 1fr 2fr; gap: 3rem; } }
    .ab-two h2 { margin: 0; font-size: 1.35rem; font-weight: 600; letter-spacing: -0.015em; }
    .ab-prose p { margin: 0 0 1rem; max-width: 64ch; line-height: 1.65; color: rgb(var(--fg-2)); }
    .ab-principles { list-style: none; margin: 0; padding: 0; display: grid; gap: 1rem; }
    .ab-principles li { max-width: 64ch; line-height: 1.6; color: rgb(var(--fg-2)); padding-left: 1rem; border-left: 2px solid rgb(var(--line-strong)); }
    .ab-principles b { color: rgb(var(--fg)); font-weight: 600; }
    .ab-parts { margin: 0; display: grid; gap: 0.9rem 1.5rem; }
    @media (min-width: 600px) { .ab-parts { grid-template-columns: 9rem 1fr; } }
    .ab-parts dt { font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 0.85rem; color: rgb(var(--fg)); }
    .ab-parts dd { margin: 0; color: rgb(var(--fg-2)); line-height: 1.6; max-width: 60ch; }
    .ab-links { display: flex; flex-wrap: wrap; gap: 0.6rem; margin-top: 0.5rem; }
  `],
})
export class AboutComponent {}
