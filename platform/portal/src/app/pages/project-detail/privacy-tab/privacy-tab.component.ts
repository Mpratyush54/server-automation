import { Component, Input, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../../services/api.service';

interface ScrubRule {
  id: string;
  name?: string;
  pattern: string;
  replacement?: string;
  flags?: string;
  enabled?: boolean;
}

@Component({
  selector: 'app-privacy-tab',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
<div class="privacy-tab">
  @if (error) {
    <p class="err">{{ error }}</p>
  }
  @if (loading) {
    <p>Loading privacy settings…</p>
  }

  @if (settings) {
    <section class="card">
      <h2>PII scrubbing</h2>
      <p class="hint">
        Server-side redaction is authoritative (Alloy + API). Built-in rules cover emails, tokens,
        card numbers and IPs. Add project-specific regex rules below.
      </p>
      <label class="check">
        <input type="checkbox" [(ngModel)]="scrubIps" /> Redact IP addresses on the API path
      </label>
      <h3>Built-in</h3>
      <ul class="builtins">
        @for (r of settings.builtinScrubRules || []; track r.id) {
          <li><code>{{ r.id }}</code> — {{ r.name || r.pattern }}</li>
        }
      </ul>
      <h3>Custom rules</h3>
      @for (r of rules; track $index) {
        <div class="rule-row">
          <input [(ngModel)]="r.id" placeholder="id" />
          <input [(ngModel)]="r.pattern" placeholder="regex pattern" class="grow" />
          <input [(ngModel)]="r.replacement" placeholder="replacement" />
          <button type="button" class="btn btn-sm" (click)="removeRule($index)">Remove</button>
        </div>
      }
      <div class="actions">
        <button type="button" class="btn btn-sm" (click)="addRule()">Add rule</button>
        <button type="button" class="btn btn-sm btn-primary" [disabled]="busy" (click)="saveScrubbing()">Save scrubbing</button>
      </div>
    </section>

    <section class="card">
      <h2>Retention (days)</h2>
      <p class="hint">
        Defaults: logs/traces/profiles 30d, replays 7d, errors 90d, heatmaps 90d (anonymous aggregates). Cluster Loki/Tempo/Pyroscope
        use <code>TELEMETRY_RETENTION_DAYS</code>; stream retention applies for replays/errors labels.
      </p>
      <div class="grid">
        @for (k of retentionKeys; track k) {
          <label>
            {{ k }}
            <input type="number" min="1" max="365" [(ngModel)]="retention[k]" />
          </label>
        }
      </div>
      <button type="button" class="btn btn-sm btn-primary" [disabled]="busy" (click)="saveRetention()">Save retention</button>
    </section>

    <section class="card">
      <h2>Consent defaults (session replay)</h2>
      <p class="hint">
        Replay itself ships in #40. These defaults and the consent API
        (<code>/api/sdk/privacy/consent</code>, <code>/api/sdk/privacy/replay-allowed</code>) are the hooks it will use.
      </p>
      <label class="check"><input type="checkbox" [(ngModel)]="consent.replay" /> Replay allowed by default (opt-in recommended: off)</label>
      <label class="check"><input type="checkbox" [(ngModel)]="consent.analytics" /> Analytics allowed by default</label>
      <button type="button" class="btn btn-sm btn-primary" [disabled]="busy" (click)="saveConsentDefaults()">Save consent defaults</button>
    </section>

    <section class="card">
      <h2>GDPR delete</h2>
      <p class="hint">Removes the subject from Mongo logs/errors, consent rows, MinIO replay prefixes, and submits Loki delete requests. An audit entry is always recorded.</p>
      <div class="grid">
        <label>User id <input [(ngModel)]="gdpr.userId" placeholder="user.id" /></label>
        <label>Session id <input [(ngModel)]="gdpr.sessionId" placeholder="session id" /></label>
        <label>Email (hashed in audit) <input [(ngModel)]="gdpr.email" placeholder="optional" /></label>
      </div>
      <button type="button" class="btn btn-sm btn-danger" [disabled]="busy || (!gdpr.userId && !gdpr.sessionId)" (click)="runGdprDelete()">Delete subject data</button>
      @if (gdprResult) {
        <pre class="result">{{ gdprResult | json }}</pre>
      }
    </section>
  }

  @if (status) {
    <p class="ok">{{ status }}</p>
  }
</div>
  `,
  styles: [`
    .privacy-tab { display: flex; flex-direction: column; gap: 1.25rem; }
    .card { padding: 1rem 1.25rem; }
    .hint { color: var(--color-text-secondary); font-size: 0.85rem; }
    .check { display: flex; gap: 0.5rem; align-items: center; margin: 0.4rem 0; }
    .builtins { font-size: 0.85rem; }
    .rule-row { display: flex; gap: 0.5rem; margin-bottom: 0.4rem; flex-wrap: wrap; }
    .rule-row .grow { flex: 1; min-width: 12rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr)); gap: 0.75rem; margin: 0.75rem 0; }
    .actions { display: flex; gap: 0.5rem; margin-top: 0.75rem; }
    .err { color: #f87171; }
    .ok { color: #34d399; }
    .result { font-size: 0.8rem; overflow: auto; max-height: 16rem; }
    .btn-danger { background: #7f1d1d; color: #fecaca; border-color: #991b1b; }
  `],
})
export class PrivacyTabComponent implements OnChanges {
  @Input({ required: true }) projectId!: string;

  loading = false;
  busy = false;
  error = '';
  status = '';
  settings: any = null;
  scrubIps = true;
  rules: ScrubRule[] = [];
  retentionKeys = ['logs', 'traces', 'profiles', 'replays', 'errors', 'heatmaps'] as const;
  retention: Record<string, number> = {};
  consent = { replay: false, analytics: true };
  gdpr = { userId: '', sessionId: '', email: '' };
  gdprResult: any = null;

  constructor(private api: ApiService) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['projectId'] && this.projectId) void this.load();
  }

  async load() {
    this.loading = true;
    this.error = '';
    try {
      this.settings = await firstValueFrom(this.api.getProjectPrivacy(this.projectId));
      this.scrubIps = this.settings.scrubIps !== false;
      this.rules = (this.settings.scrubRules || []).map((r: ScrubRule) => ({ ...r }));
      this.retention = { ...(this.settings.retentionDays || {}) };
      this.consent = {
        replay: !!this.settings.consentDefaults?.replay,
        analytics: this.settings.consentDefaults?.analytics !== false,
      };
    } catch (e: any) {
      this.error = e?.error?.error || e?.message || 'Failed to load privacy settings';
    } finally {
      this.loading = false;
    }
  }

  addRule() {
    this.rules.push({ id: '', pattern: '', replacement: '[REDACTED]', flags: 'gi', enabled: true });
  }

  removeRule(i: number) {
    this.rules.splice(i, 1);
  }

  async saveScrubbing() {
    this.busy = true;
    this.status = '';
    this.error = '';
    try {
      this.settings = await firstValueFrom(this.api.updateProjectPrivacyScrubbing(this.projectId, {
        scrubIps: this.scrubIps,
        rules: this.rules.filter((r) => r.id && r.pattern),
      }));
      this.status = 'Scrubbing rules saved';
      this.rules = (this.settings.scrubRules || []).map((r: ScrubRule) => ({ ...r }));
    } catch (e: any) {
      this.error = e?.error?.error || e?.message || 'Save failed';
    } finally {
      this.busy = false;
    }
  }

  async saveRetention() {
    this.busy = true;
    this.status = '';
    this.error = '';
    try {
      this.settings = await firstValueFrom(this.api.updateProjectPrivacyRetention(this.projectId, this.retention));
      this.retention = { ...(this.settings.retentionDays || {}) };
      this.status = 'Retention saved';
    } catch (e: any) {
      this.error = e?.error?.error || e?.message || 'Save failed';
    } finally {
      this.busy = false;
    }
  }

  async saveConsentDefaults() {
    this.busy = true;
    this.status = '';
    this.error = '';
    try {
      this.settings = await firstValueFrom(this.api.updateProjectPrivacyConsentDefaults(this.projectId, this.consent));
      this.status = 'Consent defaults saved';
    } catch (e: any) {
      this.error = e?.error?.error || e?.message || 'Save failed';
    } finally {
      this.busy = false;
    }
  }

  async runGdprDelete() {
    if (!confirm('Permanently delete telemetry for this subject? This cannot be undone.')) return;
    this.busy = true;
    this.status = '';
    this.error = '';
    this.gdprResult = null;
    try {
      this.gdprResult = await firstValueFrom(this.api.gdprDelete(this.projectId, {
        userId: this.gdpr.userId || undefined,
        sessionId: this.gdpr.sessionId || undefined,
        email: this.gdpr.email || undefined,
      }));
      this.status = 'GDPR delete completed (see result + audit log)';
    } catch (e: any) {
      this.error = e?.error?.error || e?.message || 'Delete failed';
    } finally {
      this.busy = false;
    }
  }
}
