import { Component, Input, OnChanges, SimpleChanges, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../../services/api.service';
import { DialogService } from '../../../shared/feedback/feedback.service';

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
  templateUrl: './privacy-tab.component.html',
  styleUrl: './privacy-tab.component.css',
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
  retentionKeys = ['logs', 'replays', 'errors', 'heatmaps'] as const;
  /** Project overrides only; empty = default. */
  retention: Record<string, number | null> = {};
  consent = { replay: false, analytics: true };
  gdpr = { userId: '', sessionId: '', email: '' };
  gdprResult: any = null;
  /** Panel whose save button was pressed last, so its footer shows the outcome. */
  lastPanel: 'scrubbing' | 'retention' | 'consent' | 'gdpr' | '' = '';

  /** Plain labels for the retention table (keys match retentionKeys and the API). */
  readonly retentionLabels: Record<string, { label: string; help: string }> = {
    logs: { label: 'Logs', help: 'Log lines from your services.' },
    replays: { label: 'Session replays', help: 'Recorded browser sessions.' },
    errors: { label: 'Errors', help: 'Error events and their stack traces.' },
    heatmaps: { label: 'Heatmaps', help: 'Anonymous click and scroll totals.' },
  };
  /** Counts shown after a GDPR delete (keys of the API's `deleted` object). */
  readonly gdprCountLabels: Array<[string, string]> = [
    ['logs', 'Log entries'],
    ['errors', 'Error events'],
    ['consents', 'Consent records'],
    ['replayObjects', 'Replay files'],
    ['lokiRequests', 'Log-store delete requests'],
  ];

  private dialog = inject(DialogService);

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
      this.retention = { ...(this.settings.retentionOverrides || {}) };
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
      // Empty field -> null clears the override (back to the default).
      const body: Record<string, number | null> = {};
      for (const k of this.retentionKeys) {
        const v = this.retention[k];
        body[k] = v === null || v === undefined || (v as any) === '' ? null : Number(v);
      }
      this.settings = await firstValueFrom(this.api.updateProjectPrivacyRetention(this.projectId, body));
      this.retention = { ...(this.settings.retentionOverrides || {}) };
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
    const subject = this.gdpr.userId || this.gdpr.sessionId || this.gdpr.email || '';
    const ok = await this.dialog.confirm({
      title: 'Delete all telemetry for this subject?',
      message: 'Every event, session and replay recorded for this subject in this project is deleted permanently. This cannot be undone.',
      confirmLabel: 'Delete telemetry',
      danger: true,
      typeToConfirm: subject || undefined,
    });
    if (!ok) return;
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
