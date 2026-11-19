import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../services/api.service';
import { errorText } from '../../shared/feedback/feedback.service';

export interface LicenseView {
  available: boolean;
  status: string | null;
  state: 'valid' | 'attention' | 'invalid' | 'unknown';
  plan: string | null;
  org: string | null;
  maxNodes: number | null;
  maxInstalls: number | null;
  expiresAt: string | null;
  updatedAt: string | null;
  enforce: boolean;
}

export const MANAGE_LICENSE_URL = 'https://cairnpaas.dev/account';
export const ENTERPRISE_QUOTE_URL = 'https://cairnpaas.dev/pricing#enterprise';

@Component({
  selector: 'app-license-settings',
  standalone: true,
  imports: [CommonModule],
  styleUrl: './settings.component.css',
  template: `
<section class="card card-flush st-section" aria-labelledby="license-title" data-testid="license-settings">
  <div class="card-header">
    <h2 id="license-title">License</h2>
    @if (license?.available) {
      <span class="status" [ngClass]="badgeClass" data-testid="license-badge">{{ badgeText }}</span>
    }
  </div>
  @if (loadError) {
    <p class="st-body st-msg st-err" role="alert">{{ loadError }}</p>
  } @else if (!license) {
    <p class="st-body hint">Loading license…</p>
  } @else if (!license.available) {
    <div class="st-body">
      <p class="st-note" data-testid="license-empty">No license on this server yet. Add a key with <span class="mono">sudo platformctl license activate</span>.</p>
    </div>
  } @else {
    <div class="st-rows">
      <div class="st-row">
        <div class="st-label"><span class="st-label-text">Plan</span></div>
        <div class="st-field">{{ planText }}</div>
      </div>
      <div class="st-row">
        <div class="st-label"><span class="st-label-text">Limits</span></div>
        <div class="st-field">{{ limitsText }}</div>
      </div>
      <div class="st-row">
        <div class="st-label"><span class="st-label-text">Expires</span></div>
        <div class="st-field">{{ license.expiresAt ? (license.expiresAt | date:'mediumDate') : 'No expiry date' }}</div>
      </div>
      <div class="st-row">
        <div class="st-label"><span class="st-label-text">Last updated</span></div>
        <div class="st-field">{{ license.updatedAt ? (license.updatedAt | date:'medium') : 'Not yet' }}</div>
      </div>
    </div>
  }
  <div class="st-footer">
    <a class="btn btn-primary" [href]="manageUrl" target="_blank" rel="noopener">Manage license</a>
    <a class="btn" [href]="quoteUrl" target="_blank" rel="noopener">Get an Enterprise quote</a>
  </div>
</section>
`,
})
export class LicenseSettingsComponent implements OnInit {
  private api = inject(ApiService);
  readonly manageUrl = MANAGE_LICENSE_URL;
  readonly quoteUrl = ENTERPRISE_QUOTE_URL;
  license: LicenseView | null = null;
  loadError = '';

  async ngOnInit() {
    try {
      this.license = await firstValueFrom(this.api.getLicense()) as LicenseView;
    } catch (err) {
      this.loadError = errorText(err, 'Could not load the license.');
    }
  }

  get badgeClass(): string {
    switch (this.license?.state) {
      case 'valid': return 'status-ok';
      case 'attention': return 'status-warn';
      default: return 'status-down';
    }
  }

  get badgeText(): string {
    switch (this.license?.state) {
      case 'valid': return 'Valid';
      case 'attention': return 'Needs attention';
      case 'invalid': return 'Not valid';
      default: return 'Unknown';
    }
  }

  get planText(): string {
    const l = this.license;
    if (!l?.plan) return 'Unknown';
    const name = l.plan.charAt(0).toUpperCase() + l.plan.slice(1);
    return l.org ? `${name} · ${l.org}` : name;
  }

  get limitsText(): string {
    const l = this.license;
    const nodes = l?.maxNodes ? `Up to ${l.maxNodes} ${l.maxNodes === 1 ? 'node' : 'nodes'}` : 'Unlimited nodes';
    const installs = l?.maxInstalls ? `${l.maxInstalls} ${l.maxInstalls === 1 ? 'install' : 'installs'}` : 'unlimited installs';
    return `${nodes}, ${installs}`;
  }
}
