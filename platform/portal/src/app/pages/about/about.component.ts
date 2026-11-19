import { Component } from '@angular/core';
import { RouterModule } from '@angular/router';
import { SiteHeaderComponent } from '../../shared/site/site-header.component';
import { SiteFooterComponent } from '../../shared/site/site-footer.component';
import { CairnMarkComponent } from '../../shared/site/cairn-mark.component';

interface CompareCell { text: string; ok: boolean; on: boolean }
interface CompareRow { label: string; cells: CompareCell[] }

const row = (label: string, hosted: [string, boolean], diy: [string, boolean], cairn: [string, boolean]): CompareRow => ({
  label,
  cells: [
    { text: hosted[0], ok: hosted[1], on: false },
    { text: diy[0], ok: diy[1], on: false },
    { text: cairn[0], ok: cairn[1], on: true },
  ],
});

/** "Why it exists": hosted platforms, doing it yourself and Cairn, side by side. */
export const ABOUT_COMPARE: CompareRow[] = [
  row('Servers', ['Rented from the host', false], ['Yours', true], ['Yours', true]),
  row('Where data lives', ['With the host', false], ['On your machines', true], ['On your machines', true]),
  row('Cost', ['Grows with every app', false], ['Your servers', true], ['Per server, not per app', true]),
  row('Setup and upkeep', ['Done for you', true], ['Kubernetes, certificates, databases, backups and alerts, by hand', false], ['Done once, the same way every time', true]),
  row('Day to day', ['One place to deploy', true], ['Tools stitched together', false], ['One place to deploy, one place to watch', true]),
];

/** "How it is built": the parts, in the order the diagram shows them. */
export const ABOUT_PARTS = [
  { name: 'Portal', text: 'The web dashboard for developers and operators.' },
  { name: 'API', text: 'Manages projects, deployments, databases, users and alerts.' },
  { name: 'MCP server', text: 'Gives AI assistants scoped, approved access.' },
  { name: 'SDKs', text: 'Node.js, React, Angular and Python libraries for credentials and telemetry.' },
  { name: 'platformctl', text: 'Command-line tool that installs, joins, upgrades, backs up and restores servers.' },
];

/** Public About page (#187). */
@Component({
  selector: 'app-about',
  standalone: true,
  imports: [RouterModule, SiteHeaderComponent, SiteFooterComponent, CairnMarkComponent],
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

      <section class="ab-section" aria-labelledby="ab-why">
        <div class="ab-frame">
          <div class="ab-head">
            <h2 class="ab-h2" id="ab-why">Why it exists</h2>
            <p class="ab-sub">Hosted platforms are easy, but you rent them. Running everything yourself keeps control and cost, but every team becomes an operations team.</p>
          </div>
          <table class="ab-vs">
            <caption class="ab-sr">Hosted platforms, doing it yourself and Cairn compared</caption>
            <thead>
              <tr>
                <td class="ab-vs-corner"></td>
                <th scope="col">Hosted platforms</th>
                <th scope="col">Doing it yourself</th>
                <th scope="col" class="ab-vs-on"><span class="ab-vs-brand"><app-cairn-mark class="ab-vs-mark"></app-cairn-mark>Cairn</span></th>
              </tr>
            </thead>
            <tbody>
              @for (r of compare; track r.label) {
                <tr>
                  <th scope="row">{{ r.label }}</th>
                  @for (c of r.cells; track c.text) {
                    <td [class.ab-vs-on]="c.on" [class.ab-vs-no]="!c.ok"><div class="ab-vs-cell">
                      @if (c.ok) {
                        <svg class="ab-mark ab-mark-yes" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg><span class="ab-sr">Yes: </span>
                      } @else {
                        <svg class="ab-mark ab-mark-no" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg><span class="ab-sr">No: </span>
                      }
                      <span>{{ c.text }}</span>
                    </div></td>
                  }
                </tr>
              }
            </tbody>
          </table>
        </div>
      </section>

      <section class="ab-section" aria-labelledby="ab-get">
        <div class="ab-frame">
          <div class="ab-head">
            <h2 class="ab-h2" id="ab-get">What you get</h2>
            <p class="ab-sub">Everything a team needs to ship and run apps, set up by one installer.</p>
          </div>
          <ul class="ab-bento">
            <li class="ab-tile ab-t-git">
              <div class="ab-tile-text"><h3>Deploy from Git</h3><p>Connect a repository, deploy to development, staging or production.</p></div>
              <svg class="ab-ill" viewBox="0 0 360 96" aria-hidden="true">
                <path class="ab-ill-line" d="M16 48H120"/>
                <circle class="ab-ill-dot" cx="24" cy="48" r="5"/><circle class="ab-ill-dot" cx="60" cy="48" r="5"/><circle class="ab-ill-hot" cx="96" cy="48" r="6"/>
                <path class="ab-ill-line" d="M120 48C150 48 150 16 180 16H196M120 48H196M120 48C150 48 150 80 180 80H196"/>
                <rect class="ab-ill-box" x="200" y="4" width="148" height="24" rx="12"/><text class="ab-ill-t" x="274" y="20.5">development</text>
                <rect class="ab-ill-box" x="200" y="36" width="148" height="24" rx="12"/><text class="ab-ill-t" x="274" y="52.5">staging</text>
                <rect class="ab-ill-box ab-ill-box-on" x="200" y="68" width="148" height="24" rx="12"/><text class="ab-ill-t" x="274" y="84.5">production</text>
              </svg>
            </li>
            <li class="ab-tile ab-t-db">
              <svg class="ab-icon" viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="5.5" rx="7" ry="2.5"/><path d="M5 5.5v13c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-13M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5"/></svg>
              <div class="ab-tile-text"><h3>Databases</h3><p>Credentials delivered to your app.</p></div>
              <ul class="ab-chips"><li>PostgreSQL</li><li>MongoDB</li><li>Redis</li></ul>
            </li>
            <li class="ab-tile ab-t-mon">
              <div class="ab-tile-text"><h3>Monitoring</h3><p>Metrics, logs, traces, errors and alerts in one portal.</p></div>
              <svg class="ab-ill" viewBox="0 0 320 72" aria-hidden="true">
                <path class="ab-ill-grid" d="M0 18H320M0 36H320M0 54H320"/>
                <path class="ab-ill-area" d="M0 52L28 48L56 50L84 40L112 44L140 30L168 36L196 22L224 28L252 14L280 24L320 18V72H0Z"/>
                <path class="ab-ill-spark" d="M0 52L28 48L56 50L84 40L112 44L140 30L168 36L196 22L224 28L252 14L280 24L320 18"/>
                <circle class="ab-ill-hot" cx="252" cy="14" r="4"/>
              </svg>
            </li>
            <li class="ab-tile ab-t-ha">
              <div class="ab-tile-text"><h3>High availability</h3><p>Three servers keep apps and databases running when one fails.</p></div>
              <svg class="ab-ill" viewBox="0 0 320 72" aria-hidden="true">
                <path class="ab-ill-line" d="M60 36H260"/>
                <g transform="translate(16 12)"><rect class="ab-ill-box" width="88" height="48" rx="8"/><circle class="ab-ill-ok" cx="16" cy="16" r="4"/><path class="ab-ill-rule" d="M28 16H72M16 32H60"/></g>
                <g transform="translate(116 12)"><rect class="ab-ill-box ab-ill-box-down" width="88" height="48" rx="8"/><circle class="ab-ill-down" cx="16" cy="16" r="4"/><path class="ab-ill-rule" d="M28 16H72M16 32H60"/></g>
                <g transform="translate(216 12)"><rect class="ab-ill-box" width="88" height="48" rx="8"/><circle class="ab-ill-ok" cx="16" cy="16" r="4"/><path class="ab-ill-rule" d="M28 16H72M16 32H60"/></g>
              </svg>
            </li>
            <li class="ab-tile ab-t-bak">
              <svg class="ab-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16l-1.6 12.2a2 2 0 0 1-2 1.8H7.6a2 2 0 0 1-2-1.8L4 7Z"/><path d="M3 7c0-1.1 4-2.5 9-2.5S21 5.9 21 7"/><rect x="9" y="12" width="6" height="5" rx="1"/><path d="M10 12v-1.2a2 2 0 0 1 4 0V12"/></svg>
              <div class="ab-tile-text"><h3>Backups</h3><p>Encrypted backups to a bucket you choose, with restore tests.</p></div>
            </li>
            <li class="ab-tile ab-t-ai">
              <div class="ab-tile-text"><h3>AI agents</h3><p>Assistants read status and request changes through MCP, with human approval.</p></div>
              <ol class="ab-flow" aria-label="How an assistant's change is approved">
                <li><span class="ab-flow-k">Assistant</span><span>requests a change</span></li>
                <li class="ab-flow-on"><span class="ab-flow-k">A person</span><span>approves it</span></li>
                <li><span class="ab-flow-k">Cairn</span><span>runs it</span></li>
              </ol>
            </li>
          </ul>
        </div>
      </section>

      <section class="ab-section" aria-labelledby="ab-hold">
        <div class="ab-frame">
          <div class="ab-head">
            <h2 class="ab-h2" id="ab-hold">What we hold ourselves to</h2>
          </div>
          <ul class="ab-rules">
            <li>
              <svg class="ab-glyph" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="7" rx="2"/><rect x="4" y="13" width="16" height="7" rx="2"/><path d="M8 7.5h.01M8 16.5h.01"/></svg>
              <b>Your servers, your data.</b><span>Everything runs on machines you control.</span>
            </li>
            <li>
              <svg class="ab-glyph" viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2"/></svg>
              <b>Useful on one server.</b><span>One machine is a complete install; more servers add high availability.</span>
            </li>
            <li>
              <svg class="ab-glyph" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/></svg>
              <b>Proven parts.</b><span>Kubernetes, PostgreSQL, Grafana and other widely used tools, not reinvented.</span>
            </li>
            <li>
              <svg class="ab-glyph" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3Z"/><path d="M9 12l2 2 4-4"/></svg>
              <b>Safe by default.</b><span>Two-factor sign-in, roles, an audit log and a firewall from the first install.</span>
            </li>
            <li>
              <svg class="ab-glyph" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v4h-4"/></svg>
              <b>Recoverable.</b><span>Failover is tested by switching servers off under load.</span>
            </li>
            <li>
              <svg class="ab-glyph" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c2.2 2.3 3.2 5 3.2 8s-1 5.7-3.2 8c-2.2-2.3-3.2-5-3.2-8s1-5.7 3.2-8Z"/></svg>
              <b>Open.</b><span>Roadmap, releases and issues are public on GitHub.</span>
            </li>
          </ul>
        </div>
      </section>

      <section class="ab-section" aria-labelledby="ab-built">
        <div class="ab-frame">
          <div class="ab-head">
            <h2 class="ab-h2" id="ab-built">How it is built</h2>
            <p class="ab-sub">Every part runs on your servers. platformctl sets them up; the portal, API and MCP server run on top, next to your apps.</p>
          </div>
          <figure class="ab-arch">
            <svg class="ab-arch-wide" viewBox="0 0 1120 470" aria-hidden="true">
              <defs>
                <marker id="ab-arrow-w" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="ab-d-head" d="M0 1L9 5L0 9Z"/></marker>
              </defs>
              <rect class="ab-d-frame" x="20" y="72" width="1080" height="320" rx="16"/>
              <text class="ab-d-frame-t" x="40" y="100" text-anchor="start">Your servers</text>
              <rect class="ab-d-actor" x="50" y="8" width="230" height="40" rx="20"/><text class="ab-d-name" x="165" y="33">Developers and operators</text>
              <rect class="ab-d-actor" x="645" y="8" width="230" height="40" rx="20"/><text class="ab-d-name" x="760" y="33">AI assistants</text>
              <path class="ab-d-link" d="M165 48V136" marker-end="url(#ab-arrow-w)"/><text class="ab-d-label" x="177" y="116" text-anchor="start">browser</text>
              <path class="ab-d-link" d="M760 48V136" marker-end="url(#ab-arrow-w)"/><text class="ab-d-label" x="772" y="116" text-anchor="start">MCP, with approval</text>


              <rect class="ab-d-box" x="50" y="138" width="230" height="64" rx="10"/><text class="ab-d-name" x="165" y="167">Portal</text><text class="ab-d-label" x="165" y="187">web dashboard</text>
              <rect class="ab-d-box ab-d-core" x="350" y="138" width="230" height="64" rx="10"/><text class="ab-d-name" x="465" y="167">API</text><text class="ab-d-label" x="465" y="187">projects, deploys, databases, alerts</text>
              <rect class="ab-d-box" x="645" y="138" width="230" height="64" rx="10"/><text class="ab-d-name" x="760" y="167">MCP server</text><text class="ab-d-label" x="760" y="187">scoped tools</text>
              <rect class="ab-d-box ab-d-apps" x="905" y="138" width="170" height="64" rx="10"/><text class="ab-d-name" x="990" y="167">Your apps</text><text class="ab-d-label" x="990" y="187">with the SDKs</text>
              <path class="ab-d-link" d="M280 170H346" marker-end="url(#ab-arrow-w)"/>
              <path class="ab-d-link" d="M645 170H584" marker-end="url(#ab-arrow-w)"/>
              <path class="ab-d-link ab-d-soft" d="M990 202V224H465V206" marker-end="url(#ab-arrow-w)"/><text class="ab-d-label" x="728" y="218">credentials, telemetry</text>

              <rect class="ab-d-band" x="50" y="244" width="1025" height="40" rx="8"/><text class="ab-d-name" x="70" y="269" text-anchor="start">Kubernetes</text><text class="ab-d-label" x="1055" y="269" text-anchor="end">runs everything above</text>

              @for (x of serverXs; track x) {
                <g [attr.transform]="'translate(' + x + ' 302)'"><rect class="ab-d-box" width="230" height="64" rx="10"/><path class="ab-d-rule" d="M20 24H130M20 40H90"/><circle class="ab-d-ok" cx="206" cy="24" r="5"/><text class="ab-d-label" x="206" y="48" text-anchor="end">Ubuntu</text></g>
              }
              <text class="ab-d-label" x="1075" y="328" text-anchor="end">one server is a</text><text class="ab-d-label" x="1075" y="346" text-anchor="end">complete install;</text><text class="ab-d-label" x="1075" y="364" text-anchor="end">more add HA</text>

              <path class="ab-d-link ab-d-accent" d="M165 420V372" marker-end="url(#ab-arrow-w)"/>
              <rect class="ab-d-box ab-d-cli" x="50" y="420" width="230" height="44" rx="10"/><text class="ab-d-name ab-d-mono" x="165" y="447">platformctl</text>
              <text class="ab-d-label" x="300" y="447" text-anchor="start">installs, joins, upgrades, backs up and restores the servers</text>
            </svg>
            <svg class="ab-arch-narrow" viewBox="0 0 360 700" aria-hidden="true">
              <defs>
                <marker id="ab-arrow-n" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="ab-d-head" d="M0 1L9 5L0 9Z"/></marker>
              </defs>
              <rect class="ab-d-frame" x="1" y="60" width="358" height="510" rx="14"/>
              <text class="ab-d-frame-t" x="16" y="84" text-anchor="start">Your servers</text>
              <rect class="ab-d-actor" x="4" y="4" width="166" height="40" rx="20"/><text class="ab-d-name ab-d-sm" x="87" y="29">Developers, operators</text>
              <rect class="ab-d-actor" x="190" y="4" width="166" height="40" rx="20"/><text class="ab-d-name ab-d-sm" x="273" y="29">AI assistants</text>
              <path class="ab-d-link" d="M87 44V112" marker-end="url(#ab-arrow-n)"/><text class="ab-d-label" x="95" y="104" text-anchor="start">browser</text>
              <path class="ab-d-link" d="M273 44V112" marker-end="url(#ab-arrow-n)"/><text class="ab-d-label" x="281" y="104" text-anchor="start">MCP</text>


              <rect class="ab-d-box" x="16" y="114" width="150" height="56" rx="10"/><text class="ab-d-name" x="91" y="139">Portal</text><text class="ab-d-label" x="91" y="157">web dashboard</text>
              <rect class="ab-d-box" x="194" y="114" width="150" height="56" rx="10"/><text class="ab-d-name" x="269" y="139">MCP server</text><text class="ab-d-label" x="269" y="157">scoped tools</text>
              <path class="ab-d-link" d="M91 170V206" marker-end="url(#ab-arrow-n)"/>
              <path class="ab-d-link" d="M269 170V206" marker-end="url(#ab-arrow-n)"/>
              <rect class="ab-d-box ab-d-core" x="16" y="208" width="328" height="60" rx="10"/><text class="ab-d-name" x="180" y="233">API</text><text class="ab-d-label" x="180" y="252">projects, deploys, databases, alerts</text>
              <path class="ab-d-link ab-d-soft" d="M180 314V272" marker-end="url(#ab-arrow-n)"/><text class="ab-d-label" x="190" y="298" text-anchor="start">credentials, telemetry</text>
              <rect class="ab-d-box ab-d-apps" x="16" y="316" width="328" height="50" rx="10"/><text class="ab-d-name" x="180" y="338">Your apps</text><text class="ab-d-label" x="180" y="355">with the SDKs</text>
              <rect class="ab-d-band" x="16" y="384" width="328" height="38" rx="8"/><text class="ab-d-name" x="180" y="408">Kubernetes</text>
              <g transform="translate(16 440)"><rect class="ab-d-box" width="100" height="56" rx="10"/><circle class="ab-d-ok" cx="84" cy="16" r="4.5"/><path class="ab-d-rule" d="M14 16H60M14 30H44"/><text class="ab-d-label" x="14" y="46" text-anchor="start">Ubuntu</text></g>
              <g transform="translate(130 440)"><rect class="ab-d-box" width="100" height="56" rx="10"/><circle class="ab-d-ok" cx="84" cy="16" r="4.5"/><path class="ab-d-rule" d="M14 16H60M14 30H44"/><text class="ab-d-label" x="14" y="46" text-anchor="start">Ubuntu</text></g>
              <g transform="translate(244 440)"><rect class="ab-d-box" width="100" height="56" rx="10"/><circle class="ab-d-ok" cx="84" cy="16" r="4.5"/><path class="ab-d-rule" d="M14 16H60M14 30H44"/><text class="ab-d-label" x="14" y="46" text-anchor="start">Ubuntu</text></g>
              <text class="ab-d-label" x="180" y="526">one server is a complete install;</text>
              <text class="ab-d-label" x="180" y="544">more add high availability</text>

              <path class="ab-d-link ab-d-accent" d="M180 612V574" marker-end="url(#ab-arrow-n)"/>
              <rect class="ab-d-box ab-d-cli" x="90" y="612" width="180" height="42" rx="10"/><text class="ab-d-name ab-d-mono" x="180" y="638">platformctl</text>
              <text class="ab-d-label" x="180" y="676">installs, joins, upgrades,</text>
              <text class="ab-d-label" x="180" y="694">backs up and restores the servers</text>
            </svg>
            <figcaption>
              <dl class="ab-parts">
                @for (p of parts; track p.name) {
                  <div><dt>{{ p.name }}</dt><dd>{{ p.text }}</dd></div>
                }
              </dl>
            </figcaption>
          </figure>
        </div>
      </section>

      <section class="ab-section ab-section-end">
        <div class="ab-frame">
          <div class="ab-end">
            <div class="ab-end-plans">
              <a class="ab-end-plan" routerLink="/pricing"><span class="ab-end-name">Personal</span><span class="ab-end-price">Free</span><span class="ab-end-note">for personal use</span></a>
              <a class="ab-end-plan" routerLink="/pricing"><span class="ab-end-name">Enterprise</span><span class="ab-end-price">From $9</span><span class="ab-end-note">per server per month</span></a>
            </div>
            <div class="ab-end-copy">
              <p><b>Free for personal use.</b> Companies can evaluate for 60 days; Enterprise is priced per server.</p>
              <div class="ab-links">
                <a class="btn btn-primary" routerLink="/docs/getting-started/installation">Install</a>
                <a class="btn" routerLink="/pricing">Pricing</a>
                <a class="btn" href="https://github.com/Mpratyush54/server-automation" target="_blank" rel="noopener">GitHub</a>
                <a class="btn" routerLink="/docs/contribution-guide">Contribute</a>
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>
    <app-site-footer></app-site-footer>
  `,
  styleUrl: './about.component.css',
})
export class AboutComponent {
  compare = ABOUT_COMPARE;
  parts = ABOUT_PARTS;
  serverXs = [50, 310, 570];
}
