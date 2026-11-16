import {
  AfterViewInit,
  ChangeDetectorRef,
  Component,
  ElementRef,
  OnDestroy,
  QueryList,
  ViewChild,
  ViewChildren,
  inject,
} from '@angular/core';
import { RouterModule } from '@angular/router';
import { LandingFeature, landingFeatures } from './landing-clips';
import { SiteHeaderComponent } from '../../shared/site/site-header.component';
import { SiteFooterComponent } from '../../shared/site/site-footer.component';

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

/** Visitors who asked for less motion or less data get still posters: clips wait for a press of play. */
export function prefersStillClips(): boolean {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return connection?.saveData === true || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

@Component({
  selector: 'app-landing',
  standalone: true,
  imports: [RouterModule, SiteHeaderComponent, SiteFooterComponent],
  templateUrl: './landing.component.html',
  styleUrl: './landing.component.css',
})
export class LandingComponent implements AfterViewInit, OnDestroy {
  @ViewChild('topologyElement') private topologyElement?: ElementRef<HTMLElement>;
  @ViewChildren('clipFrame') private clipFrames?: QueryList<ElementRef<HTMLElement>>;
  private readonly changes = inject(ChangeDetectorRef);
  readonly steps = TOPOLOGY_STEPS;
  readonly nodes = [
    { name: 'node-1', ip: '10.0.0.11' },
    { name: 'node-2', ip: '10.0.0.12' },
    { name: 'node-3', ip: '10.0.0.13' },
  ];
  /** The feature clips, published or still to be recorded. */
  features: LandingFeature[] = landingFeatures();
  step = 0;
  paused = false;
  visible = true;
  /**
   * Clips load only when they come near the viewport. The prerendered page
   * sets this to false, so visitors without JavaScript get every published
   * clip with its poster and native controls.
   */
  lazyClips = true;
  /** Clips that came near the viewport and may load their poster and sources. */
  clipNear: Record<string, boolean> = {};
  /** Clips that have started, so their native controls show. */
  clipStarted: Record<string, boolean> = {};
  clipError: Record<string, string> = {};
  /** Muted clips play by themselves while on screen, unless motion or data is reduced. */
  autoplayClips = false;
  /** Clips the visitor paused: never restart them automatically. */
  private clipHeld: Record<string, boolean> = {};
  /** Clips the page itself is pausing (scrolled away), so the pause is not the visitor's. */
  private clipPausing: Record<string, boolean> = {};
  /** Clips at least half on screen. */
  private clipInView: Record<string, boolean> = {};
  private destroyed = false;
  private readonly onVisibility = () => {
    for (const ref of this.clipFrames?.toArray() ?? []) {
      if (document.hidden) this.pauseClip(ref.nativeElement);
      else this.syncClip(ref.nativeElement);
    }
  };
  private timer?: ReturnType<typeof setTimeout>;
  private observer?: IntersectionObserver;
  private nearObserver?: IntersectionObserver;
  private viewObserver?: IntersectionObserver;
  private motionPreference?: MediaQueryList;
  private readonly onMotionChange = (event: MediaQueryListEvent) => {
    if (event.matches) {
      this.pause();
      this.autoplayClips = false;
      for (const ref of this.clipFrames?.toArray() ?? []) this.pauseClip(ref.nativeElement);
    }
  };
  installCopied = false;
  readonly installCommand =
    'curl -fsSL https://github.com/Mpratyush54/SERVER-automation/releases/latest/download/install.sh | bash\nsudo platformctl provision';
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

  /** How many clips are recorded and published. */
  get publishedClips(): number {
    return this.features.filter((f) => f.media !== null).length;
  }

  isStarted(id: string): boolean {
    return this.clipStarted[id] === true;
  }

  errorFor(id: string): string {
    return this.clipError[id] ?? '';
  }

  /** True when a published clip may render its video element. */
  clipReady(feature: LandingFeature): boolean {
    return feature.media !== null && (!this.lazyClips || this.clipNear[feature.id] === true);
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
    this.observeClips();
    document.addEventListener('visibilitychange', this.onVisibility);
    // Reduced motion: show the rerouted state still, with the full log.
    Promise.resolve().then(() => {
      this.autoplayClips = !prefersStillClips();
      if (this.motionPreference?.matches) {
        this.step = 3;
        this.paused = true;
      } else {
        this.schedule();
      }
    });
  }

  /**
   * Two observers per published clip: one loads it a little before it
   * scrolls into view, the other plays it (muted) while at least half of it
   * is visible and pauses it when it leaves. Without IntersectionObserver
   * every clip loads and none plays by itself.
   */
  private observeClips() {
    const frames = this.clipFrames?.toArray().map((ref) => ref.nativeElement) ?? [];
    if (!frames.length) return;
    if (typeof IntersectionObserver === 'undefined') {
      Promise.resolve().then(() => {
        this.clipNear = Object.fromEntries(this.features.map((f) => [f.id, true]));
      });
      return;
    }
    this.nearObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const frame = entry.target as HTMLElement;
        const id = frame.dataset['clip'];
        if (!entry.isIntersecting || !id) continue;
        this.nearObserver?.unobserve(frame);
        this.clipNear = { ...this.clipNear, [id]: true };
        // Observer callbacks run outside Angular: render the video now, then
        // start it if it is already on screen.
        this.changes.detectChanges();
        this.syncClip(frame);
      }
    }, { rootMargin: '400px 0px' });
    this.viewObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const frame = entry.target as HTMLElement;
        const id = frame.dataset['clip'];
        if (!id) continue;
        this.clipInView[id] = entry.intersectionRatio >= 0.5;
        this.syncClip(frame);
      }
    }, { threshold: [0, 0.5] });
    for (const frame of frames) {
      this.nearObserver.observe(frame);
      this.viewObserver.observe(frame);
    }
  }

  /** Play a clip that is on screen (when allowed), pause one that is not. */
  private syncClip(frame: HTMLElement) {
    const id = frame.dataset['clip'];
    const video = frame.querySelector('video');
    if (!id || !video) return;
    if (!this.clipInView[id] || document.hidden) this.pauseClip(frame);
    else if (this.autoplayClips && !this.clipHeld[id] && video.paused) void this.startClip(id, video, true);
  }

  private pauseClip(frame: HTMLElement) {
    const id = frame.dataset['clip'];
    const video = frame.querySelector('video');
    if (!id || !video || video.paused) return;
    this.clipPausing[id] = true;
    video.pause();
  }

  /** Start a clip: automatically when it scrolls into view, or from the play button. Clips have no sound. */
  async startClip(id: string, video: HTMLVideoElement, automatic = false) {
    this.clipError = { ...this.clipError, [id]: '' };
    if (!automatic) this.clipHeld[id] = false;
    video.muted = true;
    try {
      await video.play();
      if (this.destroyed) return;
      this.clipStarted = { ...this.clipStarted, [id]: true };
      // It may have scrolled away (or the tab been hidden) while starting.
      if (automatic && (!this.clipInView[id] || document.hidden)) {
        this.clipPausing[id] = true;
        video.pause();
      }
      // A press hid the play button: keep keyboard focus on the clip.
      if (!automatic) video.focus();
    } catch {
      if (this.destroyed) return;
      if (!automatic) this.clipError = { ...this.clipError, [id]: 'The clip could not start. Press play to try again.' };
    }
    if (automatic) this.changes.detectChanges();
  }

  /** Playing again (native controls included) lifts a visitor's hold. */
  onClipPlay(id: string) {
    this.clipHeld[id] = false;
  }

  /** The clip's file could not load: show the error and the play button again. */
  onClipError(id: string) {
    this.clipStarted = { ...this.clipStarted, [id]: false };
    this.clipError = { ...this.clipError, [id]: 'The clip could not load. Press play to try again.' };
    this.changes.detectChanges();
  }

  /** A pause the page did not cause came from the visitor: leave that clip paused. */
  onClipPause(id: string) {
    if (this.clipPausing[id]) this.clipPausing[id] = false;
    else this.clipHeld[id] = true;
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
    this.destroyed = true;
    document.removeEventListener('visibilitychange', this.onVisibility);
    if (this.copyTimer) clearTimeout(this.copyTimer);
    if (this.timer) clearTimeout(this.timer);
    this.observer?.disconnect();
    this.nearObserver?.disconnect();
    this.viewObserver?.disconnect();
    this.motionPreference?.removeEventListener('change', this.onMotionChange);
  }
}

