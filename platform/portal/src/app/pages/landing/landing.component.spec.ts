import {
  fakeAsync,
  flushMicrotasks,
  TestBed,
  tick,
} from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { LandingComponent, TOPOLOGY_STEPS } from './landing.component';
import { FEATURE_CLIPS, MEDIA_BASE, landingFeatures } from './landing-clips';

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

  it('serves published clips from the media host, lazily, without autoplay attributes', () => {
    const fixture = TestBed.createComponent(LandingComponent);
    const c = fixture.componentInstance;
    c.features = landingFeatures({ install: 'a1b2c3d4e5f6' });
    fixture.detectChanges();
    // Nothing loads before the clip comes near the viewport.
    expect(fixture.nativeElement.querySelector('video')).toBeNull();
    c.clipNear = { install: true };
    fixture.detectChanges();
    const videos = fixture.nativeElement.querySelectorAll('video') as NodeListOf<HTMLVideoElement>;
    expect(videos.length).toBe(1);
    const video = videos[0];
    expect(video.closest('[data-clip]')!.getAttribute('data-clip')).toBe('install');
    expect(video.preload).toBe('none');
    expect(video.autoplay).toBeFalse();
    expect(video.controls).toBeFalse();
    expect(video.getAttribute('poster')).toBe(`${MEDIA_BASE}/install-poster.jpg?v=a1b2c3d4e5f6`);
    expect([...video.querySelectorAll('source')].map((s) => [s.getAttribute('type'), s.getAttribute('src')])).toEqual([
      ['video/webm', `${MEDIA_BASE}/install.webm?v=a1b2c3d4e5f6`],
      ['video/mp4', `${MEDIA_BASE}/install.mp4?v=a1b2c3d4e5f6`],
    ]);
    expect(video.querySelector('track[kind="captions"]')!.getAttribute('src')).toBe(`${MEDIA_BASE}/install.en.vtt?v=a1b2c3d4e5f6`);
    expect(MEDIA_BASE).toBe('https://media.cairnpaas.dev/v1');
    // The other features still say their recording is coming.
    expect(fixture.nativeElement.querySelectorAll('.lp-pending').length).toBe(FEATURE_CLIPS.length - 1);
  });

  it('starts a clip from its play button and keeps a visitor pause', async () => {
    const fixture = TestBed.createComponent(LandingComponent);
    const c = fixture.componentInstance;
    c.features = landingFeatures({ install: 'a1b2c3d4e5f6' });
    c.clipNear = { install: true };
    fixture.detectChanges();
    const video = fixture.nativeElement.querySelector('video') as HTMLVideoElement;
    const play = spyOn(video, 'play').and.resolveTo();
    (fixture.nativeElement.querySelector('.lp-play') as HTMLButtonElement).click();
    // The topology story keeps a timer running, so wait for the click's promise rather than for a stable zone.
    await new Promise((resolve) => setTimeout(resolve));
    fixture.detectChanges();
    expect(play).toHaveBeenCalled();
    expect(video.muted).toBeTrue();
    expect(c.isStarted('install')).toBeTrue();
    expect(video.controls).toBeTrue();
    expect((fixture.nativeElement.querySelector('.lp-play') as HTMLElement).hidden).toBeTrue();
    // A pause the page did not cause is the visitor's: automatic playback must not undo it.
    c.onClipPause('install');
    c.autoplayClips = true;
    play.calls.reset();
    (c as unknown as { clipInView: Record<string, boolean> }).clipInView = { install: true };
    (c as unknown as { syncClip(frame: HTMLElement): void }).syncClip(video.closest('[data-clip]') as HTMLElement);
    expect(play).not.toHaveBeenCalled();
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

  it('keeps playback failures recoverable from the play button', async () => {
    const fixture = TestBed.createComponent(LandingComponent);
    const c = fixture.componentInstance;
    c.features = landingFeatures({ install: 'a1b2c3d4e5f6' });
    c.clipNear = { install: true };
    fixture.detectChanges();
    const video = fixture.nativeElement.querySelector('video') as HTMLVideoElement;
    spyOn(video, 'play').and.rejectWith(new Error('Network failed'));
    await c.startClip('install', video);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.lp-clip-error').hidden).toBeFalse();
    expect(c.isStarted('install')).toBeFalse();
    expect((fixture.nativeElement.querySelector('.lp-play') as HTMLElement).hidden).toBeFalse();
  });
});
