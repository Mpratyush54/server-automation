import {
  fakeAsync,
  flushMicrotasks,
  TestBed,
  tick,
} from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { LandingComponent, TOPOLOGY_STEPS } from './landing.component';

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

  it('offers user-controlled video with captions and no autoplay', () => {
    const fixture = TestBed.createComponent(LandingComponent);
    fixture.detectChanges();
    const videos = fixture.nativeElement.querySelectorAll('video') as NodeListOf<HTMLVideoElement>;
    expect(videos.length).toBe(2);
    videos.forEach((video) => {
      expect(video.controls).toBeFalse();
      expect(video.autoplay).toBeFalse();
      expect(video.preload).toBe('none');
      expect(video.querySelector('track[kind="captions"]')).toBeTruthy();
      expect(video.querySelector('source')?.src).toMatch(/\.mp4\?v=[a-f0-9]{12}$/);
    });
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
    expect(fixture.nativeElement.querySelector('.lp-caption').textContent).toContain('Every confirmed write is kept');
    fixture.destroy();
  }));

  it('keeps playback failures recoverable from the play button', async () => {
    const fixture = TestBed.createComponent(LandingComponent);
    fixture.detectChanges();
    const video = fixture.nativeElement.querySelector('video') as HTMLVideoElement;
    spyOn(video, 'play').and.rejectWith(new Error('Network failed'));
    await fixture.componentInstance.playVideo(video, 'landscape');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.video-error').hidden).toBeFalse();
    expect(fixture.componentInstance.landscapeStarted).toBeFalse();
  });
});
