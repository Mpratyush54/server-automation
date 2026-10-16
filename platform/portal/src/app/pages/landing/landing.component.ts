import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
} from '@angular/core';
import { RouterModule } from '@angular/router';
import { landingMedia } from './landing-media';

@Component({
  selector: 'app-landing',
  standalone: true,
  imports: [RouterModule],
  templateUrl: './landing.component.html',
  styleUrl: './landing.component.css',
})
export class LandingComponent implements AfterViewInit, OnDestroy {
  @ViewChild('storyElement') private storyElement?: ElementRef<HTMLElement>;
  @ViewChild('landscapeVideo')
  private landscapeVideo?: ElementRef<HTMLVideoElement>;
  @ViewChild('portraitVideo')
  private portraitVideo?: ElementRef<HTMLVideoElement>;
  readonly media = landingMedia;
  storyStep = 0;
  storyPaused = false;
  storyVisible = true;
  landscapeStarted = false;
  portraitStarted = false;
  videoError = '';
  private storyTimer?: ReturnType<typeof setInterval>;
  private storyObserver?: IntersectionObserver;
  private motionPreference?: MediaQueryList;
  private portraitPreference?: MediaQueryList;
  private readonly onMotionChange = (event: MediaQueryListEvent) => {
    if (event.matches) this.storyPaused = true;
  };
  private readonly onOrientationChange = () => {
    if (this.portraitPreference?.matches)
      this.landscapeVideo?.nativeElement.pause();
    else this.portraitVideo?.nativeElement.pause();
  };
  installCopied = false;
  readonly installCommand =
    'curl -fsSL https://github.com/Mpratyush54/SERVER-automation/releases/latest/download/install.sh | bash\nsudo platformctl provision';
  private copyTimer?: ReturnType<typeof setTimeout>;

  ngAfterViewInit() {
    this.motionPreference = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    );
    // Defer this preference update beyond Angular's initial change-detection pass.
    Promise.resolve().then(() => {
      this.storyPaused = this.motionPreference?.matches ?? false;
    });
    this.motionPreference.addEventListener('change', this.onMotionChange);
    this.portraitPreference = window.matchMedia(
      '(max-width: 760px), (orientation: portrait) and (max-width: 1050px)',
    );
    this.portraitPreference.addEventListener(
      'change',
      this.onOrientationChange,
    );
    if (typeof IntersectionObserver !== 'undefined' && this.storyElement) {
      this.storyObserver = new IntersectionObserver(
        ([entry]) => {
          this.storyVisible = entry.isIntersecting;
        },
        { threshold: 0.15 },
      );
      this.storyObserver.observe(this.storyElement.nativeElement);
    }
    this.startStoryClock();
  }

  private startStoryClock() {
    if (this.storyTimer) clearInterval(this.storyTimer);
    this.storyTimer = setInterval(() => {
      if (!this.storyPaused && this.storyVisible && !document.hidden)
        this.storyStep = (this.storyStep + 1) % 5;
    }, 6000);
  }

  selectStory(step: number) {
    this.storyStep = step;
    this.startStoryClock();
  }

  toggleStory() {
    this.storyPaused = !this.storyPaused;
    this.startStoryClock();
  }

  onVideoPlay(format: 'landscape' | 'portrait') {
    this.videoError = '';
    if (format === 'landscape') {
      this.landscapeStarted = true;
      this.portraitVideo?.nativeElement.pause();
    } else {
      this.portraitStarted = true;
      this.landscapeVideo?.nativeElement.pause();
    }
  }

  async playVideo(video: HTMLVideoElement, format: 'landscape' | 'portrait') {
    this.videoError = '';
    try {
      await video.play();
      this.onVideoPlay(format);
    } catch {
      this.videoError =
        'The video could not start. Please try the play button again.';
    }
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
    if (this.storyTimer) clearInterval(this.storyTimer);
    this.storyObserver?.disconnect();
    this.motionPreference?.removeEventListener('change', this.onMotionChange);
    this.portraitPreference?.removeEventListener(
      'change',
      this.onOrientationChange,
    );
  }
}
