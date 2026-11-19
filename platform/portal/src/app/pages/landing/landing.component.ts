import { AfterViewInit, Component, ElementRef, OnDestroy, ViewChild } from '@angular/core';
import { RouterModule } from '@angular/router';
import { LandingFeature, landingFeatures } from './landing-clips';
import { SiteHeaderComponent } from '../../shared/site/site-header.component';
import { SiteFooterComponent } from '../../shared/site/site-footer.component';
import { ClipPlayerComponent } from './clip-player.component';
import {
  COMPARISON, FEATURE_EXTRAS, FeatureExtra, INCLUDED, LATEST_RELEASE, PROOF_FACTS, REPO_URL, TOOL_GROUPS,
} from './landing-content';

/**
 * One step of the hero's failover story. The timings and figures come from
 * the 3-node power-off test (Phase 5): node NotReady at 42 s, PostgreSQL
 * promoted at 70 s, writes resumed at 2 m 33 s with no confirmed write lost.
 */
export interface TopologyStep {
  /** Node index (0..2) that is down in this step, or -1. */
  down: number;
  /** Line added to the event log when the step starts. */
  log: { time: string; text: string; tone: 'ok' | 'warn' | 'down' | '' };
  /** Caption under the diagram. */
  caption: string;
  durationMs: number;
}

export const TOPOLOGY_STEPS: TopologyStep[] = [
  { down: -1, durationMs: 4200, caption: 'Three servers share the work. Your app is served from all of them.',
    log: { time: '18:05:40', text: 'all 3 servers healthy', tone: 'ok' } },
  { down: 1, durationMs: 3200, caption: 'A server loses power.',
    log: { time: '18:06:06', text: 'node-2 stopped responding', tone: 'down' } },
  { down: 1, durationMs: 3200, caption: 'The others take over its work: the database moves its primary to a healthy server.',
    log: { time: '18:07:16', text: 'postgres primary promoted on node-1', tone: 'warn' } },
  { down: 1, durationMs: 4200, caption: 'Traffic flows through the remaining servers. In this test, no confirmed write was lost.',
    log: { time: '18:08:46', text: 'writes resumed, 0 confirmed writes lost', tone: 'ok' } },
  { down: -1, durationMs: 4200, caption: 'When the server comes back, it rejoins on its own.',
    log: { time: '18:15:02', text: 'node-2 rejoined the cluster', tone: 'ok' } },
];

@Component({
  selector: 'app-landing',
  standalone: true,
  imports: [RouterModule, SiteHeaderComponent, SiteFooterComponent, ClipPlayerComponent],
  templateUrl: './landing.component.html',
  styleUrl: './landing.component.css',
})
export class LandingComponent implements AfterViewInit, OnDestroy {
  @ViewChild('topologyElement') private topologyElement?: ElementRef<HTMLElement>;
  readonly steps = TOPOLOGY_STEPS;
  readonly nodes = [
    { name: 'node-1', ip: '10.0.0.11' },
    { name: 'node-2', ip: '10.0.0.12' },
    { name: 'node-3', ip: '10.0.0.13' },
  ];
  readonly release = LATEST_RELEASE;
  readonly repoUrl = REPO_URL;
  readonly issuesUrl = `${REPO_URL}/issues`;
  readonly releaseUrl = `${REPO_URL}/releases/tag/${LATEST_RELEASE.version}`;
  readonly facts = PROOF_FACTS;
  readonly included = INCLUDED;
  readonly toolGroups = TOOL_GROUPS;
  readonly comparison = COMPARISON;
  /** The feature clips, published or still to be recorded. */
  features: LandingFeature[] = landingFeatures();
  step = 0;
  paused = false;
  visible = true;
  /**
   * Clips load only when they come near the viewport, with the custom player.
   * The prerendered page sets this to false, so visitors without JavaScript
   * get every published clip with its poster and native controls.
   */
  lazyClips = true;
  private timer?: ReturnType<typeof setTimeout>;
  private observer?: IntersectionObserver;
  private motionPreference?: MediaQueryList;
  private readonly onMotionChange = (event: MediaQueryListEvent) => {
    if (event.matches) this.pause();
  };
  installCopied = false;
  readonly installCommand =
    'curl -fsSL https://get.cairnpaas.dev | bash\nsudo platformctl provision';
  private copyTimer?: ReturnType<typeof setTimeout>;

  get current(): TopologyStep {
    return this.steps[this.step];
  }

  /** Log lines shown so far in this cycle (newest last). */
  get logLines() {
    return this.steps.slice(0, this.step + 1).map((s) => s.log);
  }

  isDown(index: number): boolean {
    return this.current.down === index;
  }

  /** The guide link wording and "how it works" flow for one feature. */
  extra(id: string): FeatureExtra {
    return FEATURE_EXTRAS[id] ?? { more: 'Read the guide', flow: null };
  }

  /** How many clips are recorded and published. */
  get publishedClips(): number {
    return this.features.filter((f) => f.media !== null).length;
  }

  ngAfterViewInit() {
    this.motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.motionPreference.addEventListener('change', this.onMotionChange);
    if (typeof IntersectionObserver !== 'undefined' && this.topologyElement) {
      this.observer = new IntersectionObserver(([entry]) => {
        this.visible = entry.isIntersecting;
      }, { threshold: 0.2 });
      this.observer.observe(this.topologyElement.nativeElement);
    }
    // Reduced motion: show the rerouted state still, with the full log.
    Promise.resolve().then(() => {
      if (this.motionPreference?.matches) {
        this.step = 3;
        this.paused = true;
      } else {
        this.schedule();
      }
    });
  }

  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (!this.paused && this.visible && !document.hidden) {
        this.step = (this.step + 1) % this.steps.length;
      }
      this.schedule();
    }, this.current.durationMs);
  }

  pause() {
    this.paused = true;
  }

  togglePlayback() {
    this.paused = !this.paused;
    if (!this.paused) this.schedule();
  }

  selectStep(index: number) {
    this.step = index;
    this.paused = true;
  }

  async copyInstallCommand() {
    const done = () => {
      this.installCopied = true;
      if (this.copyTimer) clearTimeout(this.copyTimer);
      this.copyTimer = setTimeout(() => {
        this.installCopied = false;
      }, 2000);
    };
    try {
      await navigator.clipboard.writeText(this.installCommand);
      done();
    } catch {
      const element = document.createElement('textarea');
      element.value = this.installCommand;
      element.style.position = 'fixed';
      element.style.left = '-9999px';
      document.body.appendChild(element);
      element.select();
      try {
        if (document.execCommand('copy')) done();
      } finally {
        element.remove();
      }
    }
  }

  ngOnDestroy() {
    if (this.copyTimer) clearTimeout(this.copyTimer);
    if (this.timer) clearTimeout(this.timer);
    this.observer?.disconnect();
    this.motionPreference?.removeEventListener('change', this.onMotionChange);
  }
}

