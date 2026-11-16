import { ChangeDetectorRef, Component, Input, OnInit, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { browserLabel, formatDuration, listParams, ReplayFilters, ReplaySessionRow } from './replay-utils';

/**
 * Session replay list for a project (#40): filters by page, errors and duration.
 * Embedded in the project page's Monitoring section (Users view) with `embedded`.
 */
@Component({
  selector: 'app-replays',
  standalone: true,
  imports: [FormsModule, RouterLink, DatePipe],
  styles: [`
    :host { display: block; }
    :host > :last-child { margin-bottom: 0; }
    .rp-back { display: inline-block; margin-bottom: 12px; font-size: 0.875rem; color: rgb(var(--fg-2)); text-decoration: none; }
    .rp-back:hover { color: rgb(var(--fg)); text-decoration: underline; }
    .rp-notice {
      margin-bottom: 24px;
      padding: 12px 20px;
      border: 1px solid rgb(var(--line));
      border-left: 3px solid rgb(var(--warn));
      border-radius: 10px;
      background: rgb(var(--surface));
      font-size: 0.875rem;
      color: rgb(var(--fg-2));
    }
    .rp-notice.rp-error { border-left-color: rgb(var(--down)); color: rgb(var(--down)); }
    .rp-filters { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 12px 20px; border-bottom: 1px solid rgb(var(--line)); }
    .rp-filters input, .rp-filters select { width: auto; flex: 1 1 140px; max-width: 200px; height: 32px; }
    .rp-filters .rp-num { flex: 0 1 110px; }
    @media (max-width: 640px) { .rp-filters input, .rp-filters select, .rp-filters .rp-num { max-width: none; flex-basis: 100%; } }
    .rp-sub { display: block; margin-top: 2px; font-size: 0.8125rem; color: rgb(var(--fg-3)); }
    .rp-nowrap { white-space: nowrap; }
    .rp-err { color: rgb(var(--down)); font-weight: 600; }
    .rp-net { color: rgb(var(--warn)); }
    .rp-pages { max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.8125rem; color: rgb(var(--fg-2)); }
    .rp-right { text-align: right; }
    .rp-pager { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 20px; border-top: 1px solid rgb(var(--line)); }
    .rp-embed-head { margin-bottom: 16px; }
    .rp-embed-head h2 { margin: 0; font-size: 1rem; font-weight: 600; color: rgb(var(--fg)); }
    .rp-embed-head p { margin: 6px 0 0; font-size: 0.875rem; color: rgb(var(--fg-2)); }
    .rp-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  `],
  template: `
    @if (!embedded) {
      <a class="rp-back" [routerLink]="['/projects', projectId]">Back to project</a>
      <div class="page-header">
        <div>
          <h1 class="page-title">Session replays</h1>
          <p class="page-subtitle">Watch what users did before an error. Typed text is hidden and every view is logged.</p>
        </div>
      </div>
    } @else {
      <div class="rp-embed-head">
        <h2>Session replays</h2>
        <p>Watch what users did before an error. Typed text is hidden and every view is logged.</p>
      </div>
    }

    @if (!enabled && loaded) {
      <div class="rp-notice" data-test="disabled">New sessions are not being recorded: this needs full monitoring turned on for the server. Earlier recordings are still listed.</div>
    }
    @if (error) { <div class="rp-notice rp-error" role="alert">{{ error }}</div> }

    <section class="card card-flush" aria-label="Sessions">
      <form class="rp-filters" (ngSubmit)="offset = 0; load()" aria-label="Filter sessions">
        <input id="rp-page" name="page" aria-label="Page contains" [(ngModel)]="filters.page" placeholder="Page, e.g. /checkout">
        <select id="rp-errors" name="errors" aria-label="Errors" [(ngModel)]="filters.errors">
          <option value="">With or without errors</option><option value="true">With errors</option><option value="false">Without errors</option>
        </select>
        <input id="rp-env" name="env" aria-label="Environment" [(ngModel)]="filters.environment" placeholder="Environment">
        <input id="rp-min" name="min" class="rp-num" type="number" min="0" aria-label="Min duration (s)" placeholder="Min s" [(ngModel)]="filters.minDurationSec">
        <input id="rp-max" name="max" class="rp-num" type="number" min="0" aria-label="Max duration (s)" placeholder="Max s" [(ngModel)]="filters.maxDurationSec">
        <button type="submit" class="btn btn-sm" [disabled]="busy">Filter</button>
      </form>
      @if (busy) { <p class="empty-state">Loading sessions…</p> }
      @if (loaded && !busy && !sessions.length) { <p class="empty-state" data-test="empty">No sessions match. Recordings appear once the browser SDK has replay turned on.</p> }
      @if (sessions.length) {
        <div class="table-scroll"><table>
          <thead><tr><th>Started</th><th>Duration</th><th>Pages</th><th>Errors</th><th>User</th><th>Browser</th><th class="rp-right"><span class="rp-sr">Actions</span></th></tr></thead>
          <tbody>
            @for (s of sessions; track s.session_id) {
              <tr data-test="session-row">
                <td class="rp-nowrap">{{ s.started_at | date:'medium' }}<span class="rp-sub">{{ s.environment || '—' }}{{ s.release ? ' · ' + s.release : '' }}</span></td>
                <td class="rp-nowrap">{{ duration(s.duration_ms) }}</td>
                <td><div class="rp-pages mono" [title]="s.pages.join(', ')">{{ s.first_page || '/' }}@if (s.pages.length > 1) { <span> +{{ s.pages.length - 1 }}</span> }</div></td>
                <td class="rp-nowrap">
                  @if (s.error_count > 0) { <span class="rp-err">{{ s.error_count }}</span> } @else { 0 }
                  @if (s.network_error_count > 0) { <span class="rp-net"> · {{ s.network_error_count }} network</span> }
                </td>
                <td>{{ s.user_id || 'Anonymous' }}</td>
                <td>{{ browser(s.user_agent) }}</td>
                <td class="rp-right"><a class="btn btn-sm" [routerLink]="['/projects', projectId, 'replays', s.session_id]">Play</a></td>
              </tr>
            }
          </tbody>
        </table></div>
      }
      @if (offset > 0 || sessions.length >= 50) {
        <div class="rp-pager">
          <button type="button" class="btn btn-sm" (click)="page(-1)" [disabled]="offset === 0 || busy">Previous</button>
          <button type="button" class="btn btn-sm" (click)="page(1)" [disabled]="sessions.length < 50 || busy">Next</button>
        </div>
      }
    </section>
  `,
})
export class ReplaysComponent implements OnInit {
  private http = inject(HttpClient);
  private route = inject(ActivatedRoute);
  private cdr = inject(ChangeDetectorRef);

  /** Project id; falls back to the `:id` route param when routed standalone. */
  @Input() projectId = '';
  /** Inside the project page: no page header or back link. */
  @Input() embedded = false;
  filters: ReplayFilters = { page: '', errors: '', minDurationSec: null, maxDurationSec: null, environment: '' };
  sessions: ReplaySessionRow[] = [];
  enabled = true;
  loaded = false;
  busy = false;
  error = '';
  offset = 0;

  ngOnInit(): void {
    this.projectId = this.projectId || this.route.snapshot.paramMap.get('id') || '';
    void this.load();
  }

  duration = formatDuration;
  browser = browserLabel;

  async load(): Promise<void> {
    if (!this.projectId) return;
    this.busy = true;
    this.error = '';
    try {
      const res = await firstValueFrom(this.http.get<{ enabled: boolean; sessions: ReplaySessionRow[] }>(
        `/api/projects/${encodeURIComponent(this.projectId)}/replays`, { params: listParams(this.filters, this.offset) }));
      this.sessions = res.sessions || [];
      this.enabled = res.enabled !== false;
    } catch (e: any) {
      this.sessions = [];
      this.error = e?.status === 403 ? 'You need access to this project to view its replays.' : 'Could not load session replays.';
    } finally {
      this.busy = false;
      this.loaded = true;
      this.cdr.markForCheck();
    }
  }

  page(direction: number): void {
    this.offset = Math.max(0, this.offset + direction * 50);
    void this.load();
  }
}
