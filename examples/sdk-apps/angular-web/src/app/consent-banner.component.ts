import { Component } from '@angular/core';
import { setConsent } from '@mpratyush54/sdk-angular';

/** Session replay consent (#40/#47): nothing is recorded until the visitor allows it. */
@Component({
  selector: 'app-consent-banner',
  standalone: true,
  template: `
    @if (choice) {
      <p style="color:#555;font-size:13px">Session replay: {{ choice === '1' ? 'allowed' : 'declined' }}.</p>
    } @else {
      <div data-testid="consent-banner" style="border:1px solid #ddd;border-radius:8px;padding:12px;margin-bottom:16px">
        This demo can record a privacy-preserving session replay (all inputs masked).
        <button data-testid="replay-allow" (click)="decide(true)">Allow session replay</button>
        <button data-testid="replay-decline" (click)="decide(false)">Decline</button>
      </div>
    }
  `,
})
export class ConsentBannerComponent {
  choice: string | null = null;

  constructor() {
    try {
      this.choice = localStorage.getItem('platform.consent.replay');
    } catch {
      /* storage blocked: ask again */
    }
  }

  decide(allow: boolean): void {
    void setConsent({ replay: allow });
    this.choice = allow ? '1' : '0';
  }
}
