import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { DEFAULT_SINCE, FleetRow, fmtMs, fmtPct, fmtRate, healthLabel, humanizeStatus, isSince, SINCE_OPTIONS } from './observability-api';

type SortKey = 'health' | 'name' | 'requestRate' | 'errorRate' | 'p95Ms' | 'activeAlerts';
const HEALTH_ORDER: Record<string, number> = { critical: 0, degraded: 1, unknown: 2, healthy: 3 };

/** Fleet overview (#48): every visible project x health, rate, error rate, p95, alerts, SLOs. */
@Component({
  selector: 'app-obs-fleet',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule],
  styleUrls: ['./obs-theme.css'],
  styles: [`th button { background: none; border: 0; color: inherit; font: inherit; cursor: pointer; padding: 0; } th button:hover { color: var(--obs-text); } th button:focus-visible { outline: 2px solid rgb(var(--focus)); outline-offset: 2px; border-radius: 2px; } .obs-note { margin: -12px 0 24px; font-size: 0.8125rem; }`],
  template: `
    <div class="obs-head">
      <div>
        <h1 class="page-title">Observability</h1>
        <p class="page-subtitle">Health, traffic, errors and latency across {{ scope === 'all' ? 'all projects' : 'your projects' }}.</p>
      </div>
      <div class="obs-controls">
        <label class="obs-field">Time range
          <select class="obs-select" [(ngModel)]="since" (ngModelChange)="onSince()" aria-label="Time range">
            @for (o of sinceOptions; track o.value) { <option [value]="o.value">{{ o.label }}</option> }
          </select>
        </label>
        <button type="button" class="obs-btn" (click)="load()" [disabled]="loading">Refresh</button>
      </div>
    </div>

    @if (error) { <div class="obs-banner error" role="alert">{{ error }}</div> }
    @if (!loading && telemetryEnabled === false) {
      <div class="obs-banner" data-testid="telemetry-disabled">
        Traces, logs, metrics and profiles need the full install profile (<span class="obs-code">platformctl provision --profile full</span>).
        Alerts, errors, synthetics and SLOs are shown below.
      </div>
    }
    @if (telemetryError) { <div class="obs-banner error">{{ telemetryError }}</div> }

    <section class="obs-stats" aria-label="Summary">
      <div class="obs-stat"><span class="label">Projects</span><span class="value">{{ rows.length }}</span></div>
      <div class="obs-stat"><span class="label">Critical</span><span class="value" [class.obs-bad]="count('critical') > 0">{{ count('critical') }}</span></div>
      <div class="obs-stat"><span class="label">Degraded</span><span class="value" [class.obs-warn]="count('degraded') > 0">{{ count('degraded') }}</span></div>
      <div class="obs-stat"><span class="label">Active alerts</span><span class="value">{{ totalAlerts() }}</span></div>
    </section>

    <section class="obs-card flush" aria-label="Projects">
      @if (loading && !rows.length) {
        <div class="obs-empty">Loading…</div>
      } @else if (!rows.length) {
        <div class="obs-empty"><strong>No projects</strong>You are not a member of any project yet.</div>
      } @else {
        <div class="table-scroll"><table class="obs-table">
          <thead><tr>
            <th><button (click)="sortBy('health')">Health</button></th>
            <th><button (click)="sortBy('name')">Project</button></th>
            <th class="obs-num"><button (click)="sortBy('requestRate')">Requests</button></th>
            <th class="obs-num"><button (click)="sortBy('errorRate')">Error rate</button></th>
            <th class="obs-num"><button (click)="sortBy('p95Ms')">p95</button></th>
            <th class="obs-num"><button (click)="sortBy('activeAlerts')">Alerts</button></th>
            <th class="obs-num">Open errors</th>
            <th>Synthetics</th>
            <th>SLOs</th>
          </tr></thead>
          <tbody>
            @for (r of sorted(); track r.projectId) {
              <tr class="clickable" (click)="open(r)" [attr.data-project]="r.projectId">
                <td><span class="obs-row tight"><span class="obs-dot" [class]="'obs-dot ' + r.health"></span>{{ label(r.health) }}</span></td>
                <td><a [routerLink]="['/projects', r.projectId, 'observability']" [queryParams]="{ since }" (click)="$event.stopPropagation()">{{ r.name }}</a></td>
                <td class="obs-num">{{ rate(r.requestRate) }}</td>
                <td class="obs-num" [class.obs-bad]="(r.errorRate ?? 0) >= 5" [class.obs-warn]="(r.errorRate ?? 0) >= 1 && (r.errorRate ?? 0) < 5">{{ pct(r.errorRate) }}</td>
                <td class="obs-num">{{ ms(r.p95Ms) }}</td>
                <td class="obs-num" [class.obs-bad]="r.criticalAlerts > 0">{{ r.activeAlerts }}</td>
                <td class="obs-num">{{ r.openErrors }}</td>
                <td>{{ humanize(r.synthetics) || '—' }}</td>
                <td>@if (r.slos.total) { <span [class.obs-bad]="r.slos.breaching > 0">{{ r.slos.total - r.slos.breaching }}/{{ r.slos.total }} met</span> } @else { — }</td>
              </tr>
            }
          </tbody>
        </table></div>
      }
    </section>
    @if (truncated) { <p class="obs-faint obs-note">Only the first projects are shown.</p> }
  `,
})
export class ObsFleetComponent implements OnInit {
  private http = inject(HttpClient);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  readonly sinceOptions = SINCE_OPTIONS;
  readonly humanize = humanizeStatus;
  since = DEFAULT_SINCE;
  rows: FleetRow[] = [];
  scope: 'all' | 'member' = 'member';
  telemetryEnabled: boolean | null = null;
  telemetryError: string | null = null;
  truncated = false;
  loading = false;
  error = '';
  sortKey: SortKey = 'health';
  sortDesc = false;

  readonly rate = fmtRate;
  readonly pct = fmtPct;
  readonly ms = fmtMs;
  readonly label = healthLabel;

  async ngOnInit() {
    const s = this.route.snapshot?.queryParamMap?.get('since');
    if (isSince(s)) this.since = s!;
    await this.load();
  }

  onSince() {
    this.router.navigate([], { relativeTo: this.route, queryParams: { since: this.since }, queryParamsHandling: 'merge', replaceUrl: true });
    void this.load();
  }

  async load() {
    this.loading = true;
    this.error = '';
    try {
      const res: any = await firstValueFrom(this.http.get('/api/observability/fleet', { params: { since: this.since } }));
      this.rows = res.projects || [];
      this.scope = res.scope === 'all' ? 'all' : 'member';
      this.telemetryEnabled = !!res.telemetryEnabled;
      this.telemetryError = res.telemetryError || null;
      this.truncated = !!res.truncated;
    } catch (e: any) {
      this.error = e?.error?.error || 'Could not load the fleet overview.';
    } finally {
      this.loading = false;
    }
  }

  count(h: string): number {
    return this.rows.filter((r) => r.health === h).length;
  }

  totalAlerts(): number {
    return this.rows.reduce((n, r) => n + (r.activeAlerts || 0), 0);
  }

  sortBy(k: SortKey) {
    if (this.sortKey === k) this.sortDesc = !this.sortDesc;
    else { this.sortKey = k; this.sortDesc = k !== 'name' && k !== 'health'; }
  }

  sorted(): FleetRow[] {
    const dir = this.sortDesc ? -1 : 1;
    const k = this.sortKey;
    return [...this.rows].sort((a, b) => {
      if (k === 'name') return dir * a.name.localeCompare(b.name);
      if (k === 'health') return dir * ((HEALTH_ORDER[a.health] ?? 9) - (HEALTH_ORDER[b.health] ?? 9)) || a.name.localeCompare(b.name);
      return dir * (((a as any)[k] ?? -1) - ((b as any)[k] ?? -1));
    });
  }

  open(r: FleetRow) {
    this.router.navigate(['/projects', r.projectId, 'observability'], { queryParams: { since: this.since } });
  }
}
