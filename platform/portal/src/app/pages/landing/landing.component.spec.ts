import {
  fakeAsync,
  flushMicrotasks,
  TestBed,
  tick,
} from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { LandingComponent } from './landing.component';

describe('LandingComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [LandingComponent],
      providers: [provideRouter([])],
    }).compileComponents();
  });

  it('copies the exact installation commands shown on the page', async () => {
    const fixture = TestBed.createComponent(LandingComponent);
    fixture.detectChanges();
    const write = spyOn(navigator.clipboard, 'writeText').and.resolveTo();
    await fixture.componentInstance.copyInstallCommand();
    expect(write).toHaveBeenCalledWith(
      fixture.nativeElement
        .querySelector('.install-terminal code')
        .textContent.trim(),
    );
    expect(fixture.componentInstance.installCopied).toBeTrue();
  });

  it('offers user-controlled video with captions and no autoplay', () => {
    const fixture = TestBed.createComponent(LandingComponent);
    fixture.detectChanges();
    const videos = fixture.nativeElement.querySelectorAll(
      'video',
    ) as NodeListOf<HTMLVideoElement>;
    expect(videos.length).toBe(2);
    videos.forEach((video) => {
      expect(video.controls).toBeFalse();
      expect(video.autoplay).toBeFalse();
      expect(video.preload).toBe('none');
      expect(video.querySelector('track[kind="captions"]')).toBeTruthy();
      expect(video.querySelector('source')?.src).toMatch(
        /\.mp4\?v=[a-f0-9]{12}$/,
      );
    });
    expect(fixture.nativeElement.textContent).not.toContain(
      'Read the video transcript',
    );
    expect(fixture.nativeElement.textContent).not.toContain(
      'Download the portrait cut',
    );
  });

  it('lets visitors choose a story chapter, pause it, and resume in place', fakeAsync(() => {
    spyOnProperty(document, 'hidden', 'get').and.returnValue(false);
    const fixture = TestBed.createComponent(LandingComponent);
    fixture.detectChanges();
    flushMicrotasks();
    fixture.nativeElement.querySelectorAll('.story-chapters button')[2].click();
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('.product-story').dataset.storyStep,
    ).toBe('2');
    fixture.nativeElement.querySelector('.story-pause').click();
    tick(6000);
    expect(fixture.componentInstance.storyStep).toBe(2);
    fixture.componentInstance.storyVisible = true;
    fixture.nativeElement.querySelector('.story-pause').click();
    tick(6000);
    fixture.detectChanges();
    expect(
      fixture.nativeElement
        .querySelectorAll('.story-chapters button')[3]
        .getAttribute('aria-pressed'),
    ).toBe('true');
    fixture.destroy();
  }));

  it('keeps playback failures recoverable from the play button', async () => {
    const fixture = TestBed.createComponent(LandingComponent);
    fixture.detectChanges();
    const video = fixture.nativeElement.querySelector(
      'video',
    ) as HTMLVideoElement;
    spyOn(video, 'play').and.rejectWith(new Error('Network failed'));
    await fixture.componentInstance.playVideo(video, 'landscape');
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('.video-error').hidden,
    ).toBeFalse();
    expect(fixture.componentInstance.landscapeStarted).toBeFalse();
  });
});
