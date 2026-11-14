import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../services/api.service';
import { ToastService, errorText } from '../../shared/feedback/feedback.service';

@Component({
  selector: 'app-usage-settings',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule],
  styleUrl: './settings.component.css',
  template: `
<section class="card card-flush st-section" aria-labelledby="usage-prices-title" data-testid="usage-settings">
  <div class="card-header">
    <h2 id="usage-prices-title">Usage and costs</h2>
    <button type="button" class="btn btn-sm" (click)="exportCsv()" [disabled]="busy">Export CSV</button>
  </div>
  <div class="st-body">
    <p class="st-note">Unit prices for estimated project cost. There is no billing or payment — these figures are for planning only.</p>
  </div>
  <div class="st-rows">
    <div class="st-row">
      <div class="st-label">
        <label for="price-cpu">Per core-hour</label>
        <p>CPU metered from cAdvisor.</p>
      </div>
      <div class="st-field">
        <input id="price-cpu" type="number" min="0" step="0.001" [(ngModel)]="prices.perCoreHour" name="cpu">
      </div>
    </div>
    <div class="st-row">
      <div class="st-label">
        <label for="price-mem">Per GB-hour (memory)</label>
        <p>Working-set memory.</p>
      </div>
      <div class="st-field">
        <input id="price-mem" type="number" min="0" step="0.001" [(ngModel)]="prices.perGbHourMemory" name="mem">
      </div>
    </div>
    <div class="st-row">
      <div class="st-label">
        <label for="price-storage">Per GB-month (storage)</label>
        <p>PVC plus object storage.</p>
      </div>
      <div class="st-field">
        <input id="price-storage" type="number" min="0" step="0.001" [(ngModel)]="prices.perGbMonthStorage" name="storage">
      </div>
    </div>
    <div class="st-row">
      <div class="st-label">
        <label for="price-bw">Per GB (bandwidth)</label>
        <p>Ingress bytes per host.</p>
      </div>
      <div class="st-field">
        <input id="price-bw" type="number" min="0" step="0.001" [(ngModel)]="prices.perGbBandwidth" name="bw">
      </div>
    </div>
    <div class="st-row">
      <div class="st-label">
        <label for="price-build">Per build minute</label>
        <p>Deploy duration.</p>
      </div>
      <div class="st-field">
        <input id="price-build" type="number" min="0" step="0.001" [(ngModel)]="prices.perBuildMinute" name="build">
      </div>
    </div>
    <div class="st-row">
      <div class="st-label">
        <label for="price-server">Monthly server cost</label>
        <p>Allocated across projects by compute share.</p>
      </div>
      <div class="st-field">
        <input id="price-server" type="number" min="0" step="0.01" [(ngModel)]="prices.monthlyServerCost" name="server">
        <input id="price-currency" [(ngModel)]="prices.currency" name="currency" maxlength="8" aria-label="Currency" placeholder="USD">
      </div>
    </div>
  </div>
  <div class="st-footer">
    <button type="button" class="btn btn-primary" (click)="savePrices()" [disabled]="busy">{{ busy ? 'Saving…' : 'Save prices' }}</button>
  </div>
</section>

<section class="card card-flush st-section" aria-labelledby="usage-projects-title">
  <div class="card-header">
    <h2 id="usage-projects-title">All projects this month</h2>
  </div>
  @if (loadError) {
    <p class="st-body st-msg st-err" role="alert">{{ loadError }}</p>
  } @else if (!fleet) {
    <p class="st-body hint">Loading usage…</p>
  } @else {
    <div class="st-body">
      <p class="st-note">Fleet total {{ fleet.currency }} {{ fleet.cost.total | number:'1.2-2' }} · {{ fleet.from }} to {{ fleet.to }}</p>
    </div>
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Project</th>
            <th>CPU</th>
            <th>Memory</th>
            <th>Storage</th>
            <th>Bandwidth</th>
            <th>Est. cost</th>
          </tr>
        </thead>
        <tbody>
          @for (p of fleet.projects; track p.projectId) {
            <tr>
              <td><a [routerLink]="['/projects', p.projectId]" [queryParams]="{ tab: 'monitoring', view: 'usage' }">{{ p.projectName }}</a></td>
              <td>{{ p.metrics.cpuCoreHours | number:'1.1-1' }}</td>
              <td>{{ p.metrics.memoryGbHours | number:'1.1-1' }}</td>
              <td>{{ (p.metrics.pvcStorageGb + p.metrics.objectStorageGb) | number:'1.2-2' }}</td>
              <td>{{ p.metrics.ingressBandwidthGb | number:'1.2-2' }}</td>
              <td>{{ fleet.currency }} {{ p.cost.total | number:'1.2-2' }}</td>
            </tr>
          }
          @if (!fleet.projects.length) {
            <tr class="empty-row"><td colspan="6">No usage rollups yet.</td></tr>
          }
        </tbody>
      </table>
    </div>
  }
</section>
`,
})
export class UsageSettingsComponent implements OnInit {
  private api = inject(ApiService);
  private toast = inject(ToastService);

  prices: any = {
    perCoreHour: 0.04,
    perGbHourMemory: 0.005,
    perGbMonthStorage: 0.02,
    perGbBandwidth: 0.09,
    perBuildMinute: 0.002,
    monthlyServerCost: 0,
    currency: 'USD',
  };
  fleet: any = null;
  loadError = '';
  busy = false;

  ngOnInit(): void {
    void this.load();
  }

  async load(): Promise<void> {
    this.loadError = '';
    try {
      const [prices, fleet] = await Promise.all([
        firstValueFrom(this.api.getUsageSettings()),
        firstValueFrom(this.api.getFleetUsage()),
      ]);
      this.prices = { ...prices };
      this.fleet = fleet;
    } catch (err: any) {
      this.loadError = errorText(err) || 'Could not load usage settings';
    }
  }

  async savePrices(): Promise<void> {
    this.busy = true;
    try {
      this.prices = await firstValueFrom(this.api.updateUsageSettings(this.prices));
      this.fleet = await firstValueFrom(this.api.getFleetUsage());
      this.toast.ok('Usage prices saved');
    } catch (err: any) {
      this.toast.error(errorText(err) || 'Could not save prices');
    } finally {
      this.busy = false;
    }
  }

  async exportCsv(): Promise<void> {
    try {
      const blob = await firstValueFrom(this.api.exportFleetUsageCsv());
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'usage-all.csv';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      this.toast.error(errorText(err) || 'Export failed');
    }
  }
}
