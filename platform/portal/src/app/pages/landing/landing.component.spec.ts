import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { LandingComponent } from './landing.component';

describe('LandingComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [LandingComponent], providers: [provideRouter([])] }).compileComponents();
  });

  it('copies the exact installation commands shown on the page', async () => {
    const fixture = TestBed.createComponent(LandingComponent);
    fixture.detectChanges();
    const write = spyOn(navigator.clipboard, 'writeText').and.resolveTo();
    await fixture.componentInstance.copyInstallCommand();
    expect(write).toHaveBeenCalledWith(fixture.nativeElement.querySelector('.install-terminal code').textContent.trim());
    expect(fixture.componentInstance.installCopied).toBeTrue();
  });

  it('offers user-controlled video with captions and no autoplay', () => {
    const fixture = TestBed.createComponent(LandingComponent);
    fixture.detectChanges();
    const video = fixture.nativeElement.querySelector('video') as HTMLVideoElement;
    expect(video.controls).toBeTrue();
    expect(video.autoplay).toBeFalse();
    expect(video.preload).toBe('none');
    expect(video.querySelector('track[kind="captions"]')).toBeTruthy();
  });
});
