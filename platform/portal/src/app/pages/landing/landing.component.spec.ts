import {
  ComponentFixture,
  fakeAsync,
  flushMicrotasks,
  TestBed,
  tick,
} from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { LandingComponent, TOPOLOGY_STEPS } from './landing.component';
import { ClipPlayerComponent, clipTime } from './clip-player.component';
import { FEATURE_CLIPS, MEDIA_BASE, landingFeatures } from './landing-clips';
import { COMPARISON, LATEST_RELEASE } from './landing-content';

/** Stand-in for IntersectionObserver, so tests decide what is on screen. */
class FakeObserver {
  static all: FakeObserver[] = [];
  target?: Element;
  constructor(private readonly callback: IntersectionObserverCallback, readonly options: IntersectionObserverInit = {}) {
    FakeObserver.all.push(this);
  }
  observe(target: Element) { this.target = target; }
  unobserve() {}
  disconnect() {}
  fire(ratio: number) {
    const entry = { target: this.target, isIntersecting: ratio > 0, intersectionRatio: ratio } as unknown as IntersectionObserverEntry;
    this.callback([entry], this as unknown as IntersectionObserver);
  }
  /** The observer that loads a clip, and the one that plays it, for one player root. */
  static near(root: Element) { return FakeObserver.all.find((o) => o.target === root && !!o.options.rootMargin)!; }
  static view(root: Element) { return FakeObserver.all.find((o) => o.target === root && Array.isArray(o.options.threshold) && !o.options.rootMargin)!; }
}

let realObserver: typeof IntersectionObserver;
function useFakeObserver() {
  realObserver = window.IntersectionObserver;
  FakeObserver.all = [];
  (window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = FakeObserver;
}
function restoreObserver() {
  (window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = realObserver;
}

describe('LandingComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [LandingComponent],
      providers: [provideRouter([])],
    }).compileComponents();
  });

  it('copies exactly the install commands shown, without the prompts', async () => {
    const fixture = TestBed.createComponent(LandingComponent);
    fixture.detectChanges();
    const write = spyOn(navigator.clipboard, 'writeText').and.resolveTo();
    await fixture.componentInstance.copyInstallCommand();
    const code = (fixture.nativeElement.querySelector('.lp-install code') as HTMLElement).cloneNode(true) as HTMLElement;
    code.querySelectorAll('.lp-prompt').forEach((p) => p.remove());
    const shown = code.textContent!.split('\n').map((l) => l.trim()).join('\n').trim();
    expect(write).toHaveBeenCalledWith(shown);
    expect(fixture.componentInstance.installCopied).toBeTrue();
  });

  it('shows every feature with copy and a guide, and a placeholder until its clip is recorded', () => {
    const fixture = TestBed.createComponent(LandingComponent);
    fixture.componentInstance.features = landingFeatures({});
    fixture.detectChanges();
    const articles = fixture.nativeElement.querySelectorAll('.lp-feature') as NodeListOf<HTMLElement>;
    expect(articles.length).toBe(FEATURE_CLIPS.length);
    expect(fixture.nativeElement.querySelector('#high-availability')).toBeTruthy();
    articles.forEach((article, i) => {
      expect(article.querySelector('.lp-anchor')!.id).toBe(FEATURE_CLIPS[i].id);
      expect(article.querySelector('h3')!.textContent).toContain(FEATURE_CLIPS[i].title);
      expect(article.querySelector('a.lp-guide')!.getAttribute('href')).toBe(FEATURE_CLIPS[i].guide.path);
      expect(article.querySelector('.lp-pending-label')!.textContent).toContain('Recording coming soon');
      expect(article.querySelectorAll('.lp-pending li').length).toBe(FEATURE_CLIPS[i].shows.length);
    });
    expect(fixture.nativeElement.querySelector('video')).toBeNull();
  });

  it('pairs deploys, failover and backups with a small flow, and links every guide in plain words', () => {
    const fixture = TestBed.createComponent(LandingComponent);
    fixture.componentInstance.features = landingFeatures({});
    fixture.detectChanges();
    const withFlow = [...fixture.nativeElement.querySelectorAll('.lp-feature')]
      .filter((a: HTMLElement) => a.querySelector('.lp-flow'))
      .map((a: HTMLElement) => a.querySelector('.lp-anchor')!.id);
    expect(withFlow).toEqual(['deploy-from-git', 'backups', 'high-availability']);
    for (const flow of fixture.nativeElement.querySelectorAll('.lp-flow') as NodeListOf<HTMLElement>) {
      expect(flow.querySelectorAll('li').length).toBe(4);
      expect(flow.getAttribute('aria-label')).toBeTruthy();
    }
    // No separate diagrams section or journey row: the clips are the one story per feature.
    expect(fixture.nativeElement.querySelector('app-landing-how, .hw')).toBeNull();
    for (const link of fixture.nativeElement.querySelectorAll('a.lp-guide') as NodeListOf<HTMLElement>) {
      expect(link.textContent!.trim()).toMatch(/^How .+ works?$/);
    }
  });

  it('states the release, the price line and a cautious comparison', () => {
    const fixture = TestBed.createComponent(LandingComponent);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.lp-release')!.textContent).toContain(LATEST_RELEASE.version);
    expect(el.querySelector('.lp-release time')!.getAttribute('datetime')).toBe(LATEST_RELEASE.date);
    const price = el.querySelector('.lp-price-line a')!;
    expect(price.getAttribute('href')).toBe('/pricing');
    expect(price.textContent).toContain('Free for personal use');
    expect(el.querySelectorAll('h1').length).toBe(1);
    const rows = el.querySelectorAll('.lp-table tbody tr');
    expect(rows.length).toBe(COMPARISON.rows.length);
    for (const row of COMPARISON.rows) expect(row.cells.length).toBe(COMPARISON.columns.length);
    expect(el.querySelector('.lp-footnote')!.textContent).toContain('Based on public docs, November 2026');
  });

  it('plays the failover story, marks the failed server, and can be paused', fakeAsync(() => {
    spyOnProperty(document, 'hidden', 'get').and.returnValue(false);
    const fixture = TestBed.createComponent(LandingComponent);
    fixture.detectChanges();
    flushMicrotasks();
    const c = fixture.componentInstance;
    c.visible = true;
    expect(c.step).toBe(0);
    tick(TOPOLOGY_STEPS[0].durationMs);
    fixture.detectChanges();
    expect(c.step).toBe(1);
    // node-2 is shown as down, and the log names it.
    const nodes = fixture.nativeElement.querySelectorAll('.lp-node');
    expect(nodes[1].classList).toContain('lp-node-down');
    expect(fixture.nativeElement.querySelector('.lp-log').textContent).toContain('node-2 stopped responding');
    // Pausing stops the story where it is.
    fixture.nativeElement.querySelector('.lp-topology-play').click();
    tick(10_000);
    expect(c.step).toBe(1);
    // Choosing a step shows it and stays paused.
    fixture.nativeElement.querySelectorAll('.lp-steps button')[3].click();
    fixture.detectChanges();
    expect(c.step).toBe(3);
    expect(c.paused).toBeTrue();
    expect(fixture.nativeElement.querySelector('.lp-caption').textContent).toContain('no confirmed write was lost');
    fixture.destroy();
  }));
});

describe('ClipPlayerComponent', () => {
  const version = 'a1b2c3d4e5f6';
  let fixture: ComponentFixture<LandingComponent>;

  beforeEach(async () => {
    useFakeObserver();
    // The test browser may run in a background window; the clips only play in a visible tab.
    spyOnProperty(document, 'hidden', 'get').and.returnValue(false);
    await TestBed.configureTestingModule({
      imports: [LandingComponent],
      providers: [provideRouter([])],
    }).compileComponents();
    fixture = TestBed.createComponent(LandingComponent);
    fixture.componentInstance.features = landingFeatures({ install: version });
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
    restoreObserver();
  });

  const player = () => fixture.debugElement.query(By.directive(ClipPlayerComponent)).componentInstance as ClipPlayerComponent;
  const root = () => fixture.nativeElement.querySelector('.cp') as HTMLElement;
  const video = () => fixture.nativeElement.querySelector('video') as HTMLVideoElement;
  const q = (selector: string) => fixture.nativeElement.querySelector(selector) as HTMLElement | null;

  /** Bring the clip near the viewport, so its video renders. */
  function load() {
    FakeObserver.near(root()).fire(0.01);
    fixture.detectChanges();
    return video();
  }

  /** Let a real video element report paused or playing. */
  function setPaused(v: HTMLVideoElement, paused: () => boolean) {
    Object.defineProperty(v, 'paused', { get: paused, configurable: true });
  }

  /** What the browser does once playback really starts. */
  function startPlaying(v: HTMLVideoElement) {
    v.dispatchEvent(new Event('play'));
    v.dispatchEvent(new Event('playing'));
    fixture.detectChanges();
  }

  it('loads only near the viewport, from the media host, without native controls or default captions', () => {
    expect(video()).toBeNull();
    const v = load();
    expect(v.closest('[data-clip]')!.getAttribute('data-clip')).toBe('install');
    expect(v.preload).toBe('none');
    expect(v.autoplay).toBeFalse();
    expect(v.controls).toBeFalse();
    expect(v.muted).toBeTrue();
    expect(v.getAttribute('poster')).toBe(`${MEDIA_BASE}/install-poster.jpg?v=${version}`);
    expect([...v.querySelectorAll('source')].map((s) => [s.getAttribute('type'), s.getAttribute('src')])).toEqual([
      ['video/webm', `${MEDIA_BASE}/install.webm?v=${version}`],
      ['video/mp4', `${MEDIA_BASE}/install.mp4?v=${version}`],
    ]);
    const track = v.querySelector('track[kind="captions"]') as HTMLTrackElement;
    expect(track.getAttribute('src')).toBe(`${MEDIA_BASE}/install.en.vtt?v=${version}`);
    expect(track.hasAttribute('default')).toBeFalse();
    expect(MEDIA_BASE).toBe('https://media.cairnpaas.dev/v1');
    // The other features still say their recording is coming.
    expect(fixture.nativeElement.querySelectorAll('.lp-pending').length).toBe(FEATURE_CLIPS.length - 1);
  });

  it('plays muted when mostly on screen, pauses when it leaves, and keeps a visitor pause', async () => {
    const p = player();
    p.autoplay = true;
    const v = load();
    let paused = true;
    setPaused(v, () => paused);
    const play = spyOn(v, 'play').and.callFake(async () => { paused = false; });
    const pause = spyOn(v, 'pause').and.callFake(() => { paused = true; v.dispatchEvent(new Event('pause')); });

    // Half on screen is not enough.
    FakeObserver.view(root()).fire(0.4);
    expect(play).not.toHaveBeenCalled();
    FakeObserver.view(root()).fire(0.8);
    expect(play).toHaveBeenCalledTimes(1);
    expect(v.muted).toBeTrue();
    await Promise.resolve();
    startPlaying(v);
    expect(p.started).toBeTrue();
    expect(q('.cp-play')).toBeNull();

    // Scrolling away pauses it; that pause is the page's, so it resumes on return.
    FakeObserver.view(root()).fire(0);
    expect(pause).toHaveBeenCalledTimes(1);
    FakeObserver.view(root()).fire(0.8);
    expect(play).toHaveBeenCalledTimes(2);
    await Promise.resolve();
    startPlaying(v);

    // A visitor's pause sticks.
    (q('.cp-bar button[aria-label="Pause"]') as HTMLButtonElement).click();
    expect(pause).toHaveBeenCalledTimes(2);
    FakeObserver.view(root()).fire(0);
    FakeObserver.view(root()).fire(0.8);
    expect(play).toHaveBeenCalledTimes(2);
  });

  it('with reduced motion shows the poster and a play button, and plays only when pressed', async () => {
    const p = player();
    p.autoplay = false;
    const v = load();
    const play = spyOn(v, 'play').and.resolveTo();
    FakeObserver.view(root()).fire(1);
    fixture.detectChanges();
    expect(play).not.toHaveBeenCalled();
    const button = q('.cp-play') as HTMLButtonElement;
    expect(button.getAttribute('aria-label')).toBe(`Play the recording: ${FEATURE_CLIPS[0].title}`);
    expect(q('.cp-bar')).toBeNull();
    button.click();
    expect(play).toHaveBeenCalled();
    await Promise.resolve();
    startPlaying(v);
    expect(q('.cp-play')).toBeNull();
    expect(q('.cp-bar')).toBeTruthy();
  });

  it('shows captions only once the clip plays, on by default, with a toggle', () => {
    const p = player();
    p.autoplay = false;
    const v = load();
    p.caption = 'One command on a fresh Ubuntu server.';
    fixture.detectChanges();
    // Never over the poster.
    expect(q('.cp-caption')).toBeNull();
    startPlaying(v);
    expect(q('.cp-caption')!.textContent!.trim()).toBe('One command on a fresh Ubuntu server.');
    const cc = q('.cp-cc') as HTMLButtonElement;
    expect(cc.getAttribute('aria-pressed')).toBe('true');
    cc.click();
    fixture.detectChanges();
    expect(cc.getAttribute('aria-pressed')).toBe('false');
    expect(q('.cp-caption')).toBeNull();
    // The clip's own track stays hidden: the player draws the captions.
    expect(v.textTracks[0]?.mode).toBe('hidden');
  });

  it('every control has a label, and the keyboard works: Space or k plays, arrows seek', () => {
    const p = player();
    p.autoplay = false;
    const v = load();
    startPlaying(v);
    for (const button of fixture.nativeElement.querySelectorAll('.cp-bar button') as NodeListOf<HTMLButtonElement>) {
      expect(button.getAttribute('aria-label')).toBeTruthy();
    }
    expect(root().getAttribute('tabindex')).toBe('0');
    expect(root().getAttribute('aria-label')).toContain(FEATURE_CLIPS[0].title);

    const toggle = spyOn(p, 'togglePlay');
    root().dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    root().dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true }));
    expect(toggle).toHaveBeenCalledTimes(2);
    // Space on a button is the button's own click, not a second toggle.
    q('.cp-cc')!.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(toggle).toHaveBeenCalledTimes(2);

    // Seeking from the slider.
    p.duration = 40;
    fixture.detectChanges();
    const seek = q('.cp-seek')!;
    expect(seek.getAttribute('role')).toBe('slider');
    seek.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    fixture.detectChanges();
    expect(p.current).toBe(5);
    expect(seek.getAttribute('aria-valuenow')).toBe('5');
    expect(seek.getAttribute('aria-valuetext')).toBe('0:05 of 0:40');
    seek.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(p.current).toBe(40);
    seek.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(p.current).toBe(0);
  });

  it('seeks by clicking or dragging the progress bar', () => {
    const p = player();
    const v = load();
    startPlaying(v);
    p.duration = 40;
    fixture.detectChanges();
    const seek = q('.cp-seek')!;
    spyOn(seek, 'getBoundingClientRect').and.returnValue({ left: 100, width: 200, top: 0, height: 24, right: 300, bottom: 24, x: 100, y: 0, toJSON() {} } as DOMRect);
    seek.dispatchEvent(new PointerEvent('pointerdown', { clientX: 150, button: 0, pointerId: 1, bubbles: true }));
    expect(p.current).toBe(10);
    seek.dispatchEvent(new PointerEvent('pointermove', { clientX: 250, pointerId: 1, bubbles: true }));
    expect(p.current).toBe(30);
    seek.dispatchEvent(new PointerEvent('pointerup', { clientX: 250, pointerId: 1, bubbles: true }));
    seek.dispatchEvent(new PointerEvent('pointermove', { clientX: 120, pointerId: 1, bubbles: true }));
    expect(p.current).toBe(30);
  });

  it('opens full screen on the player, so the controls and captions stay', async () => {
    const v = load();
    startPlaying(v);
    const request = spyOn(root(), 'requestFullscreen').and.resolveTo();
    (q('.cp-bar button[aria-label="Full screen"]') as HTMLButtonElement).click();
    await Promise.resolve();
    expect(request).toHaveBeenCalled();
  });

  it('keeps load and start failures recoverable from the play button', async () => {
    const p = player();
    p.autoplay = false;
    const v = load();
    const play = spyOn(v, 'play').and.rejectWith(new Error('Network failed'));
    await p.play(true);
    fixture.detectChanges();
    expect(q('.cp-error')!.textContent).toContain('could not start');
    expect(q('.cp-play')).toBeTruthy();

    // A file that fails to load says so, and offers play again, which reloads it.
    play.and.resolveTo();
    v.querySelector('source[type="video/mp4"]')!.dispatchEvent(new Event('error'));
    fixture.detectChanges();
    expect(q('.cp-error')!.textContent).toContain('could not load');
    const reload = spyOn(v, 'load');
    (q('.cp-play') as HTMLButtonElement).click();
    expect(reload).toHaveBeenCalled();
    fixture.detectChanges();
    expect(q('.cp-error')).toBeNull();
  });

  it('a clip the browser refuses to start by itself offers the play button', async () => {
    const p = player();
    p.autoplay = true;
    const v = load();
    spyOn(v, 'play').and.rejectWith(Object.assign(new Error('blocked'), { name: 'NotAllowedError' }));
    FakeObserver.view(root()).fire(0.9);
    await new Promise((resolve) => setTimeout(resolve));
    fixture.detectChanges();
    expect(p.blocked).toBeTrue();
    expect(q('.cp-play')).toBeTruthy();
    expect(q('.cp-error')).toBeNull();
  });

  it('formats the time readout', () => {
    expect(clipTime(0)).toBe('0:00');
    expect(clipTime(65.9)).toBe('1:05');
    expect(clipTime(NaN)).toBe('0:00');
  });
});
