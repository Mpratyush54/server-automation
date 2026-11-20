import { AfterViewInit, Component, ElementRef, OnDestroy, ViewChild } from '@angular/core';
import { RouterModule } from '@angular/router';

type Spot = 'left' | 'right';
type ServerState = 'empty' | 'installing' | 'installed' | 'licensed' | 'running';

/** Where each item crossing the air gap is in one step; hidden items wait at their next start. */
interface Carry { at: Spot; shown: boolean }

/**
 * One step of the air-gapped install story. Every command and behaviour here is real:
 * docs/getting-started/platformctl.md (offline bundle) and `platformctl license
 * request-offline` / `install-offline`.
 */
export interface AirgapStep {
  caption: string;
  command: string;
  log: { text: string; tone: 'ok' | 'info' };
  bundle: Carry;
  request: Carry;
  license: Carry;
  server: ServerState;
  /** cairnpaas.dev/account is in use on the online computer. */
  portal: boolean;
  durationMs: number;
}

const at = (spot: Spot, shown = true): Carry => ({ at: spot, shown });

export const AIRGAP_STEPS: AirgapStep[] = [
  {
    caption: 'On any computer with internet, download the release bundle and its checksum: k3s, charts, images and Ubuntu packages in one file.',
    command: 'sha256sum -c platform-bundle-2.0.0-amd64.tar.zst.sha256',
    log: { text: 'bundle downloaded, checksum OK', tone: 'ok' },
    bundle: at('left'), request: at('right', false), license: at('left', false),
    server: 'empty', portal: false, durationMs: 4200,
  },
  {
    caption: 'Carry it across the air gap with platformctl: a USB drive, a one-way transfer or your jump host.',
    command: 'cp platformctl platform-bundle-2.0.0-amd64.tar.zst /media/usb/',
    log: { text: 'copied to the isolated server', tone: 'info' },
    bundle: at('right'), request: at('right', false), license: at('left', false),
    server: 'empty', portal: false, durationMs: 3800,
  },
  {
    caption: 'provision checks every file against the bundle\'s checksums and installs everything from it. Nothing is downloaded.',
    command: 'sudo platformctl provision --bundle /root/platform-bundle-2.0.0-amd64.tar.zst',
    log: { text: 'installed from the bundle: 0 downloads', tone: 'ok' },
    bundle: at('right', false), request: at('right', false), license: at('left', false),
    server: 'installed', portal: false, durationMs: 4600,
  },
  {
    caption: 'For the license, the server prints a request. Take it to cairnpaas.dev/account on the online computer.',
    command: 'sudo platformctl license request-offline',
    log: { text: 'license request created', tone: 'info' },
    bundle: at('right', false), request: at('left'), license: at('left', false),
    server: 'installed', portal: true, durationMs: 4400,
  },
  {
    caption: 'Download the license file from your account, carry it back and install it.',
    command: 'sudo platformctl license install-offline --file license.json',
    log: { text: 'licensed, offline', tone: 'ok' },
    bundle: at('right', false), request: at('left', false), license: at('right'),
    server: 'licensed', portal: true, durationMs: 4200,
  },
  {
    caption: 'Cairn runs with no internet: no check-ins, no diagnostics, no outside image pulls. Add servers the same way with join --bundle.',
    command: 'sudo platformctl join --bundle /root/platform-bundle-2.0.0-amd64.tar.zst',
    log: { text: '3 servers healthy, 0 outbound connections', tone: 'ok' },
    // The bundle waits, hidden, back on the online side for the next loop.
    bundle: at('left', false), request: at('left', false), license: at('right', false),
    server: 'running', portal: false, durationMs: 5600,
  },
];

/** Account-page explainer: installing and licensing Cairn on servers without internet access. */
@Component({
  selector: 'app-airgap-story',
  standalone: true,
  imports: [RouterModule],
  styleUrl: './airgap-story.component.css',
  template: `
    <figure class="ag" #storyElement aria-labelledby="ag-caption">
      <div class="ag-head">
        <span>Air-gapped install, step {{ step + 1 }} of {{ steps.length }}</span>
        <button type="button" class="ag-play" (click)="togglePlayback()" [attr.aria-label]="paused ? 'Play the air-gapped install story' : 'Pause the air-gapped install story'">
          {{ paused ? 'Play' : 'Pause' }}
        </button>
      </div>

      <svg class="ag-diagram" viewBox="0 0 640 286" role="img" aria-label="An online computer on the left, isolated servers on the right, and an air gap with no network between them. The bundle and the license file are carried across by hand.">
        <!-- Online side -->
        <g class="ag-side">
          <rect class="ag-zone" x="10" y="24" width="190" height="252" rx="10"></rect>
          <text class="ag-zone-label" x="24" y="46">Online computer</text>
          <g class="ag-laptop" transform="translate(27 66)">
            <rect class="ag-screen" x="0" y="0" width="156" height="84" rx="6"></rect>
            <rect class="ag-base" x="-8" y="86" width="172" height="8" rx="3"></rect>
            <text class="ag-screen-text" x="10" y="22">github.com/…/releases</text>
            <text class="ag-screen-text" [class.ag-on]="current.portal" x="10" y="44">cairnpaas.dev/account</text>
            <text class="ag-screen-text ag-dim" x="10" y="66">internet</text>
          </g>
          <circle class="ag-net" cx="186" cy="38" r="5"></circle>
        </g>

        <!-- The air gap -->
        <g class="ag-gap">
          <line x1="250" y1="20" x2="250" y2="276"></line>
          <line x1="390" y1="20" x2="390" y2="276"></line>
          <path class="ag-hand" d="M212 236 H428"></path>
          <text class="ag-gap-sub ag-hand-label" x="320" y="226" text-anchor="middle">carried by hand</text>
          <text class="ag-gap-note" x="320" y="128" text-anchor="middle">USB drive,</text>
          <text class="ag-gap-note" x="320" y="143" text-anchor="middle">one-way transfer</text>
          <text class="ag-gap-note" x="320" y="158" text-anchor="middle">or jump host</text>
          <text class="ag-gap-label" x="320" y="40" text-anchor="middle">Air gap</text>
          <text class="ag-gap-sub" x="320" y="56" text-anchor="middle">no network</text>
        </g>

        <!-- Isolated side -->
        <g class="ag-side">
          <rect class="ag-zone ag-zone-iso" x="440" y="24" width="190" height="252" rx="10"></rect>
          <text class="ag-zone-label" x="454" y="46">Your isolated servers</text>
          @for (n of servers; track n; let i = $index) {
            <g class="ag-server" [class.ag-installed]="current.server !== 'empty'" [class.ag-licensed]="current.server === 'licensed' || current.server === 'running'" [class.ag-extra]="i > 0" [class.ag-joined]="i > 0 && current.server === 'running'" [attr.transform]="'translate(462 ' + (66 + i * 50) + ')'">
              <rect width="146" height="38" rx="6"></rect>
              <circle class="ag-dot" cx="16" cy="19" r="5"></circle>
              <text x="30" y="17">{{ n }}</text>
              <text class="ag-state" x="30" y="30">{{ i === 0 ? stateLabel : (current.server === 'running' ? 'joined, healthy' : 'not installed') }}</text>
            </g>
          }
        </g>

        <!-- What crosses the gap, carried by hand -->
        <g class="ag-carry ag-bundle" [class.ag-right]="current.bundle.at === 'right'" [class.ag-hidden]="!current.bundle.shown">
          <rect x="0" y="0" width="120" height="30" rx="6"></rect>
          <text x="60" y="19" text-anchor="middle">bundle + platformctl</text>
        </g>
        <g class="ag-carry ag-request" [class.ag-right]="current.request.at === 'right'" [class.ag-hidden]="!current.request.shown">
          <rect x="0" y="0" width="120" height="30" rx="6"></rect>
          <text x="60" y="19" text-anchor="middle">license request</text>
        </g>
        <g class="ag-carry ag-license" [class.ag-right]="current.license.at === 'right'" [class.ag-hidden]="!current.license.shown">
          <rect x="0" y="0" width="120" height="30" rx="6"></rect>
          <text x="60" y="19" text-anchor="middle">license file</text>
        </g>
      </svg>

      <figcaption id="ag-caption" class="ag-caption" aria-live="polite">{{ current.caption }}</figcaption>
      <pre class="ag-command"><code>$ {{ current.command }}</code></pre>
      <p class="ag-log" [class.ag-log-ok]="current.log.tone === 'ok'"><span>{{ current.log.text }}</span></p>
      <div class="ag-steps" role="group" aria-label="Air-gapped install steps">
        @for (s of steps; track s.command; let i = $index) {
          <button type="button" [class.on]="i === step" (click)="selectStep(i)" [attr.aria-label]="'Show step ' + (i + 1) + ' of ' + steps.length" [attr.aria-pressed]="i === step ? 'true' : 'false'"></button>
        }
      </div>
    </figure>
  `,
})
export class AirgapStoryComponent implements AfterViewInit, OnDestroy {
  @ViewChild('storyElement') storyElement?: ElementRef<HTMLElement>;

  readonly steps = AIRGAP_STEPS;
  readonly servers = ['server 1', 'server 2', 'server 3'];
  step = 0;
  paused = false;
  visible = true;

  private timer?: ReturnType<typeof setTimeout>;
  private observer?: IntersectionObserver;
  private motionPreference?: MediaQueryList;

  get current(): AirgapStep {
    return this.steps[this.step];
  }

  get stateLabel(): string {
    switch (this.current.server) {
      case 'empty': return 'no internet access';
      case 'installing': return 'installing…';
      case 'installed': return 'installed, unlicensed';
      case 'licensed': return 'licensed, offline';
      default: return 'healthy, offline';
    }
  }

  ngAfterViewInit() {
    this.motionPreference = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (typeof IntersectionObserver !== 'undefined' && this.storyElement) {
      this.observer = new IntersectionObserver(([entry]) => { this.visible = entry.isIntersecting; }, { threshold: 0.25 });
      this.observer.observe(this.storyElement.nativeElement);
    }
    // Reduced motion: show the finished state, still; the step buttons still work.
    Promise.resolve().then(() => {
      if (this.motionPreference?.matches) {
        this.step = this.steps.length - 1;
        this.paused = true;
      } else {
        this.schedule();
      }
    });
  }

  ngOnDestroy() {
    if (this.timer) clearTimeout(this.timer);
    this.observer?.disconnect();
  }

  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (!this.paused && this.visible && !document.hidden) this.step = (this.step + 1) % this.steps.length;
      this.schedule();
    }, this.current.durationMs);
  }

  togglePlayback() {
    this.paused = !this.paused;
    if (!this.paused) this.schedule();
  }

  selectStep(index: number) {
    this.step = index;
    this.paused = true;
  }
}
