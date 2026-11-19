import {
  AfterViewInit,
  ChangeDetectorRef,
  Component,
  ElementRef,
  Input,
  OnDestroy,
  OnInit,
  ViewChild,
  inject,
} from '@angular/core';
import { LandingFeature } from './landing-clips';

/** Visitors who asked for less motion or less data get still posters: clips wait for a press of play. */
export function prefersStillClips(): boolean {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return connection?.saveData === true || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** m:ss for the time readout. */
export function clipTime(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Share of the clip that must be on screen before it plays by itself. */
const IN_VIEW_RATIO = 0.6;
const SEEK_STEP_S = 5;

/**
 * One feature clip. In the browser it loads when it comes near the viewport,
 * plays muted while mostly on screen and pauses when it leaves, with a small
 * control bar and its own captions. Visitors who prefer reduced motion (or
 * save data) get the poster and a play button instead.
 *
 * The prerendered page sets `staticPage`: the video then renders at once with
 * the browser's own controls, so the clip works without JavaScript.
 */
@Component({
  selector: 'app-clip-player',
  standalone: true,
  templateUrl: './clip-player.component.html',
  styleUrl: './clip-player.component.css',
})
export class ClipPlayerComponent implements OnInit, AfterViewInit, OnDestroy {
  @Input({ required: true }) feature!: LandingFeature;
  /** Static HTML for visitors without JavaScript: native controls, no custom UI. */
  @Input() staticPage = false;

  @ViewChild('root') private rootRef?: ElementRef<HTMLElement>;
  @ViewChild('seek') private seekRef?: ElementRef<HTMLElement>;
  @ViewChild('video') private set videoRef(ref: ElementRef<HTMLVideoElement> | undefined) {
    const video = ref?.nativeElement;
    if (video === this.video) return;
    this.video = video;
    if (video) this.prepare(video);
  }

  private readonly changes = inject(ChangeDetectorRef);
  private video?: HTMLVideoElement;

  /** The clip came near the viewport and may load its poster and sources. */
  near = false;
  /** The first frame has played, so the poster is gone. */
  started = false;
  playing = false;
  /** Waiting for data after a play was asked for. */
  loading = false;
  captionsOn = true;
  caption = '';
  current = 0;
  duration = 0;
  error = '';
  fullscreen = false;
  /** Muted clips play by themselves while on screen, unless motion or data is reduced. */
  autoplay = false;
  /** The browser refused to start the clip by itself: offer the play button. */
  blocked = false;
  /** The visitor paused it: never restart it automatically. */
  private held = false;
  /** The page itself is pausing it (scrolled away, tab hidden), so the pause is not the visitor's. */
  private pausingByPage = false;
  private inView = false;
  private dragging = false;
  private destroyed = false;
  private nearObserver?: IntersectionObserver;
  private viewObserver?: IntersectionObserver;
  private motionPreference?: MediaQueryList;
  private readonly onVisibility = () => this.sync();
  /** Asking for reduced motion mid-visit stops clips from playing by themselves. */
  private readonly onMotionChange = (event: MediaQueryListEvent) => {
    if (!event.matches) return;
    this.autoplay = false;
    this.pauseByPage();
    this.changes.detectChanges();
  };
  private readonly onFullscreen = () => {
    this.fullscreen = !!this.rootRef && document.fullscreenElement === this.rootRef.nativeElement;
    this.changes.detectChanges();
  };

  get progress(): number {
    return this.duration > 0 ? Math.min(1, this.current / this.duration) : 0;
  }

  /** The big play button: when the clip does not play by itself, or could not. */
  get showPlay(): boolean {
    return !this.started && (!this.autoplay || this.blocked || !!this.error || this.held);
  }

  get showCaption(): boolean {
    return this.captionsOn && this.started && !this.error && this.caption !== '';
  }

  get timeText(): string {
    return `${clipTime(this.current)} / ${clipTime(this.duration)}`;
  }

  get seekText(): string {
    return `${clipTime(this.current)} of ${clipTime(this.duration)}`;
  }

  ngOnInit() {
    if (!this.staticPage) this.autoplay = !prefersStillClips();
  }

  ngAfterViewInit() {
    if (this.staticPage || !this.rootRef) return;
    const root = this.rootRef.nativeElement;
    document.addEventListener('visibilitychange', this.onVisibility);
    document.addEventListener('fullscreenchange', this.onFullscreen);
    this.motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.motionPreference.addEventListener?.('change', this.onMotionChange);
    if (typeof IntersectionObserver === 'undefined') {
      // Load it, but never play it by itself.
      Promise.resolve().then(() => this.markNear());
      return;
    }
    this.nearObserver = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      this.nearObserver?.disconnect();
      this.markNear();
    }, { rootMargin: '400px 0px' });
    this.viewObserver = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      this.inView = entry.isIntersecting && entry.intersectionRatio >= IN_VIEW_RATIO;
      this.sync();
    }, { threshold: [0, IN_VIEW_RATIO] });
    this.nearObserver.observe(root);
    this.viewObserver.observe(root);
  }

  ngOnDestroy() {
    this.destroyed = true;
    this.nearObserver?.disconnect();
    this.viewObserver?.disconnect();
    document.removeEventListener('visibilitychange', this.onVisibility);
    document.removeEventListener('fullscreenchange', this.onFullscreen);
    this.motionPreference?.removeEventListener?.('change', this.onMotionChange);
  }

  private markNear() {
    if (this.destroyed || this.near) return;
    this.near = true;
    // Observer callbacks run outside Angular: render the video now, then start it if it is on screen.
    this.changes.detectChanges();
    this.sync();
  }

  /** Captions come from the clip's track but are drawn by the player, only once the clip plays. */
  private prepare(video: HTMLVideoElement) {
    video.muted = true;
    const track = video.textTracks?.[0];
    if (!track) return;
    track.mode = 'hidden';
    track.addEventListener('cuechange', () => {
      const cue = track.activeCues?.[0] as (TextTrackCue & { text?: string }) | undefined;
      this.caption = cue?.text?.trim() ?? '';
      if (!this.destroyed) this.changes.detectChanges();
    });
  }

  /** Play a clip that is on screen (when allowed), pause one that is not. */
  private sync() {
    const video = this.video;
    if (!video || this.destroyed) return;
    if (!this.inView || document.hidden) this.pauseByPage();
    else if (this.autoplay && !this.held && !this.blocked && !this.error && video.paused) void this.play(false);
  }

  private pauseByPage() {
    const video = this.video;
    if (!video || video.paused) return;
    this.pausingByPage = true;
    video.pause();
  }

  /** Start the clip: automatically when it scrolls into view, or from a press. Clips have no sound. */
  async play(byVisitor = true) {
    const video = this.video;
    if (!video) return;
    if (byVisitor) {
      this.held = false;
      this.blocked = false;
    }
    if (this.error) {
      this.error = '';
      video.load();
    }
    video.muted = true;
    this.loading = true;
    try {
      await video.play();
      if (this.destroyed) return;
      // It may have scrolled away (or the tab been hidden) while starting.
      if (!byVisitor && (!this.inView || document.hidden)) this.pauseByPage();
    } catch (e) {
      if (this.destroyed) return;
      this.loading = false;
      // A pause while starting interrupts play(); that is not a failure.
      if ((e as Error)?.name !== 'AbortError') {
        if (byVisitor) this.error = 'The clip could not start. Press play to try again.';
        else this.blocked = true;
      }
    }
    if (!byVisitor && !this.destroyed) this.changes.detectChanges();
  }

  togglePlay() {
    const video = this.video;
    if (!video) return;
    if (video.paused) void this.play(true);
    else video.pause();
  }

  toggleCaptions() {
    this.captionsOn = !this.captionsOn;
  }

  async toggleFullscreen() {
    const root = this.rootRef?.nativeElement;
    const video = this.video as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | undefined;
    if (!root) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (root.requestFullscreen) await root.requestFullscreen();
      else video?.webkitEnterFullscreen?.(); // iPhone Safari only has native video full screen.
    } catch {
      video?.webkitEnterFullscreen?.();
    }
  }

  seekBy(seconds: number) {
    this.seekTo(this.current + seconds);
  }

  seekTo(seconds: number) {
    const video = this.video;
    if (!video || !(this.duration > 0)) return;
    const time = Math.max(0, Math.min(this.duration, seconds));
    video.currentTime = time;
    this.current = time;
  }

  onSeekPointerDown(event: PointerEvent) {
    if (event.button !== 0) return;
    this.dragging = true;
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    this.seekToPointer(event);
  }

  onSeekPointerMove(event: PointerEvent) {
    if (this.dragging) this.seekToPointer(event);
  }

  onSeekPointerUp(event: PointerEvent) {
    if (!this.dragging) return;
    this.dragging = false;
    (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
  }

  get seeking(): boolean {
    return this.dragging;
  }

  private seekToPointer(event: PointerEvent) {
    const rect = this.seekRef?.nativeElement.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    this.seekTo(((event.clientX - rect.left) / rect.width) * this.duration);
  }

  /** Space or k plays and pauses; arrows seek; c and f toggle captions and full screen. */
  onKeydown(event: KeyboardEvent) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement;
    const onButton = target.tagName === 'BUTTON';
    const onSeek = target === this.seekRef?.nativeElement;
    switch (event.key) {
      case 'k':
      case 'K':
        this.togglePlay();
        break;
      case ' ':
        if (onButton) return; // the button's own click handles it
        this.togglePlay();
        break;
      case 'c':
      case 'C':
        if (!this.started) return;
        this.toggleCaptions();
        break;
      case 'f':
      case 'F':
        void this.toggleFullscreen();
        break;
      case 'ArrowLeft':
      case 'ArrowRight':
        if (onButton) return;
        this.seekBy(event.key === 'ArrowLeft' ? -SEEK_STEP_S : SEEK_STEP_S);
        break;
      case 'Home':
      case 'End':
        if (!onSeek) return;
        this.seekTo(event.key === 'Home' ? 0 : this.duration);
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  // Media events
  onPlay() {
    this.held = false;
    this.playing = true;
  }

  onPlaying() {
    this.playing = true;
    this.started = true;
    this.loading = false;
    this.blocked = false;
  }

  onWaiting() {
    if (!this.video?.paused) this.loading = true;
  }

  onPause() {
    this.playing = false;
    this.loading = false;
    if (this.pausingByPage) this.pausingByPage = false;
    else this.held = true;
  }

  onTime() {
    if (!this.dragging && this.video) this.current = this.video.currentTime;
  }

  onMeta() {
    const d = this.video?.duration ?? 0;
    this.duration = Number.isFinite(d) ? d : 0;
  }

  /** The clip's file could not load: show the error and the play button again. */
  onError() {
    this.error = 'The clip could not load. Press play to try again.';
    this.started = false;
    this.playing = false;
    this.loading = false;
    if (!this.destroyed) this.changes.detectChanges();
  }
}
