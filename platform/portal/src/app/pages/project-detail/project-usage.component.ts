import { Component, Input, OnChanges, SimpleChanges, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { ToastService, errorText } from '../../shared/feedback/feedback.service';

interface QuotaBar {
  used: number;
  limit: number | null;
  percent: number | null;
}

@Component({
  selector: 'app-project-usage',
  standalone: true,
  imports: [CommonModule, FormsModule],
  styleUrls: ['./project-section-shared.css', './project-usage.component.css'],
  template: `
<section class="card card-flush" data-testid="project-usage" aria-labelledby="usage-title">
  <div class="card-header">
    <h2 id="usage-title">Usage</h2>
    <div class="inline-form">
      <button type="button" class="btn btn-sm" (click)="exportCsv()" [disabled]="busy || !report">Export CSV</button>
    </div>
  </div>

  @if (error) {
    <p class="mon-notice" role="alert">{{ error }}</p>
  } @else if (!report) {
    <p class="hint usage-pad">Loading this month's usage…</p>
  } @else {
    <div class="usage-pad stack">
      <div class="grid-3">
        <div>
          <h3 class="stat-label">Estimated cost</h3>
          <div class="stat" data-testid="usage-cost">{{ report.currency }} {{ report.cost.total | number:'1.2-2' }}</div>
          <p class="hint">{{ report.from }} to {{ report.to }}</p>
        </div>
        <div>
          <h3 class="stat-label">CPU</h3>
          <div class="stat">{{ report.totals.cpuCoreHours | number:'1.1-1' }} <span class="hint">core-hours</span></div>
        </div>
        <div>
          <h3 class="stat-label">Memory</h3>
          <div class="stat">{{ report.totals.memoryGbHours | number:'1.1-1' }} <span class="hint">GB-hours</span></div>
        </div>
      </div>

      <div class="grid-3">
        <div>
          <h3 class="stat-label">Storage</h3>
          <div class="stat">{{ storageGb | number:'1.2-2' }} <span class="hint">GB</span></div>
        </div>
        <div>
          <h3 class="stat-label">Bandwidth</h3>
          <div class="stat">{{ report.totals.ingressBandwidthGb | number:'1.2-2' }} <span class="hint">GB</span></div>
        </div>
        <div>
          <h3 class="stat-label">Build time</h3>
          <div class="stat">{{ report.totals.buildMinutes | number:'1.1-1' }} <span class="hint">min</span></div>
        </div>
      </div>

      <section aria-labelledby="usage-chart-title">
        <h3 id="usage-chart-title" class="stat-label">Daily CPU (core-hours)</h3>
        @if (chartBars.length === 0) {
          <p class="hint">No daily rollups yet. Usage is collected a few times a day from Prometheus.</p>
        } @else {
          <div class="usage-chart" role="img" [attr.aria-label]="'Daily CPU chart, max ' + chartMax">
            @for (b of chartBars; track b.day) {
              <div class="usage-bar-col" [title]="b.day + ': ' + b.value">
                <progress class="usage-day" [value]="b.value" [max]="chartMax" [attr.aria-label]="b.day"></progress>
                <span class="usage-bar-label">{{ b.day.slice(8) }}</span>
              </div>
            }
          </div>
        }
      </section>

      <section aria-labelledby="usage-quota-title">
        <h3 id="usage-quota-title" class="stat-label">Quotas (month to date)</h3>
        <ul class="usage-quota-list">
          @for (q of quotaEntries; track q.key) {
            <li>
              <div class="usage-quota-head">
                <span>{{ q.label }}</span>
                <span class="status" [class.status-ok]="q.status === 'ok'" [class.status-warn]="q.status === 'warn'" [class.status-down]="q.status === 'down'">{{ q.statusWord }}</span>
              </div>
              @if (q.limit != null) {
                <progress class="quota" [value]="q.used" [max]="q.limit" [attr.aria-label]="q.label + ' quota'"></progress>
                <p class="hint">{{ q.used | number:'1.1-1' }} / {{ q.limit | number:'1.1-1' }} ({{ q.percent | number:'1.0-0' }}%)</p>
              } @else {
                <p class="hint">No limit · used {{ q.used | number:'1.1-1' }}</p>
              }
            </li>
          }
        </ul>

        @if (canEditQuota) {
          <details class="usage-quota-edit">
            <summary>Edit quotas</summary>
            <div class="st-rows">
              <div class="inline-form">
                <label class="form-group">CPU core-hours<input type="number" min="0" [(ngModel)]="quotaForm.cpuCoreHours" name="cpu"></label>
                <label class="form-group">Memory GB-hours<input type="number" min="0" [(ngModel)]="quotaForm.memoryGbHours" name="mem"></label>
                <label class="form-group">Storage GB<input type="number" min="0" [(ngModel)]="quotaForm.storageGb" name="storage"></label>
                <label class="form-group">Bandwidth GB<input type="number" min="0" [(ngModel)]="quotaForm.bandwidthGb" name="bw"></label>
              </div>
              <button type="button" class="btn btn-primary btn-sm" (click)="saveQuota()" [disabled]="busy">Save quotas</button>
            </div>
          </details>
        }
      </section>
    </div>
  }
</section>
`,
})
export class ProjectUsageComponent implements OnChanges {
  @Input({ required: true }) projectId = '';

  private api = inject(ApiService);
  private auth = inject(AuthService);
  private toast = inject(ToastService);

  report: any = null;
  error = '';
  busy = false;
  canEditQuota = this.auth.isTechLeadOrDevOps();
  quotaForm: {
    cpuCoreHours: number | null;
    memoryGbHours: number | null;
    storageGb: number | null;
    bandwidthGb: number | null;
  } = {
    cpuCoreHours: null,
    memoryGbHours: null,
    storageGb: null,
    bandwidthGb: null,
  };
  chartBars: { day: string; value: number }[] = [];
  chartMax = 1;

  get storageGb(): number {
    if (!this.report?.totals) return 0;
    return (this.report.totals.pvcStorageGb || 0) + (this.report.totals.objectStorageGb || 0);
  }

  get quotaEntries(): Array<{
    key: string; label: string; used: number; limit: number | null; percent: number | null;
    status: 'ok' | 'warn' | 'down'; statusWord: string;
  }> {
    const bars: Record<string, QuotaBar> = this.report?.quotaBars || {};
    const labels: Record<string, string> = {
      cpuCoreHours: 'CPU',
      memoryGbHours: 'Memory',
      storageGb: 'Storage',
      bandwidthGb: 'Bandwidth',
      buildMinutes: 'Build time',
    };
    return Object.keys(labels).map((key) => {
      const b = bars[key] || { used: 0, limit: null, percent: null };
      let status: 'ok' | 'warn' | 'down' = 'ok';
      let statusWord = 'ok';
      if (b.percent != null && b.percent >= 100) { status = 'down'; statusWord = 'exceeded'; }
      else if (b.percent != null && b.percent >= 80) { status = 'warn'; statusWord = 'warning'; }
      else if (b.limit == null) { statusWord = 'unlimited'; }
      return { key, label: labels[key], used: b.used, limit: b.limit, percent: b.percent, status, statusWord };
    });
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['projectId'] && this.projectId) void this.load();
  }

  async load(): Promise<void> {
    this.error = '';
    this.report = null;
    try {
      this.report = await firstValueFrom(this.api.getProjectUsage(this.projectId));
      this.chartBars = (this.report.daily || []).map((d: any) => ({
        day: d.day,
        value: Number(d.metrics?.cpuCoreHours) || 0,
      }));
      this.chartMax = Math.max(1, ...this.chartBars.map((b) => b.value));
      const q = this.report.quota || {};
      this.quotaForm = {
        cpuCoreHours: q.cpuCoreHours,
        memoryGbHours: q.memoryGbHours,
        storageGb: q.storageGb,
        bandwidthGb: q.bandwidthGb,
      };
    } catch (err: any) {
      this.error = errorText(err) || 'Could not load usage';
    }
  }

  async saveQuota(): Promise<void> {
    this.busy = true;
    try {
      await firstValueFrom(this.api.updateProjectUsageQuota(this.projectId, this.quotaForm));
      this.toast.ok('Quotas saved');
      await this.load();
    } catch (err: any) {
      this.toast.error(errorText(err) || 'Could not save quotas');
    } finally {
      this.busy = false;
    }
  }

  async exportCsv(): Promise<void> {
    try {
      const blob = await firstValueFrom(this.api.exportProjectUsageCsv(this.projectId));
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `usage-${this.projectId}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      this.toast.error(errorText(err) || 'Export failed');
    }
  }
}
