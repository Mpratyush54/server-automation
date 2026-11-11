import { ChangeDetectorRef, Component, OnInit, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { browserLabel, formatDuration, listParams, ReplayFilters, ReplaySessionRow } from './replay-utils';

/** Session replay list for a project (#40): filters by page, errors and duration. */
@Component({
  selector: 'app-replays',
  standalone: true,
  imports: [FormsModule, RouterLink, DatePipe],
  styles: [`
    :host { display: block; color: #e4e4e7; }
    .muted { color: #a1a1aa; font-size: 13px; }
    form { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-end; margin: 16px 0; }
    label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #a1a1aa; }
    input, select { background: #111; border: 1px solid #333; color: #e4e4e7; border-radius: 6px; padding: 7px 9px; min-width: 120px; }
    button, a.btn { background: #18181b; border: 1px solid #3f3f46; color: #e4e4e7; border-radius: 6px; padding: 7px 12px; cursor: pointer; text-decoration: none; font-size: 13px; }
    button:disabled { opacity: .5; cursor: default; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid #27272a; vertical-align: top; }
    th { color: #a1a1aa; font-weight: 500; }
    .err { color: #f87171; font-weight: 600; }
    .net { color: #fbbf24; }
    .pages { color: #a1a1aa; font-size: 12px; max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .notice { border: 1px solid #3f3f46; border-radius: 8px; padding: 12px 14px; margin: 12px 0; background: #111; font-size: 13px; }
    .pager { display: flex; gap: 8px; margin-top: 12px; }
  `],
  template: `
    <a class="btn" [routerLink]="['/projects', projectId]">&larr; Project</a>
    <h1 class="page-title">Session replays</h1>
    <p class="muted">Recorded with inputs masked. Replays are kept for the project's replay retention and every view is audited.</p>

    @if (!enabled && loaded) {
      <div class="notice" data-test="disabled">Session replay ingest is not enabled on this platform (full observability profile), or no
        replay storage is configured. Existing recordings are still listed.</div>
    }
    @if (error) { <div class="notice err" role="alert">{{ error }}</div> }

    <form (ngSubmit)="offset = 0; load()">
      <label>Page contains <input name="page" [(ngModel)]="filters.page" placeholder="e.g. /checkout"></label>
      <label>Errors
        <select name="errors" [(ngModel)]="filters.errors">
          <option value="">Any</option><option value="true">With errors</option><option value="false">Without errors</option>
        </select>
      </label>
      <label>Min duration (s) <input name="min" type="number" min="0" [(ngModel)]="filters.minDurationSec"></label>
      <label>Max duration (s) <input name="max" type="number" min="0" [(ngModel)]="filters.maxDurationSec"></label>
      <label>Environment <input name="env" [(ngModel)]="filters.environment" placeholder="e.g. production"></label>
      <button type="submit" [disabled]="busy">Filter</button>
    </form>

    @if (busy) { <p class="muted">Loading…</p> }
    <div class="table-scroll"><table>
      <thead><tr><th>Started</th><th>Duration</th><th>Pages</th><th>Errors</th><th>User</th><th>Browser</th><th></th></tr></thead>
      <tbody>
        @for (s of sessions; track s.session_id) {
          <tr data-test="session-row">
            <td>{{ s.started_at | date:'medium' }}<br><span class="muted">{{ s.environment || '—' }}{{ s.release ? ' · ' + s.release : '' }}</span></td>
            <td>{{ duration(s.duration_ms) }}</td>
            <td><div class="pages" [title]="s.pages.join(', ')">{{ s.first_page || '/' }}@if (s.pages.length > 1) { <span> +{{ s.pages.length - 1 }}</span> }</div></td>
            <td>
              @if (s.error_count > 0) { <span class="err">{{ s.error_count }}</span> } @else { 0 }
              @if (s.network_error_count > 0) { <span class="net"> · {{ s.network_error_count }} net</span> }
            </td>
            <td>{{ s.user_id || 'anonymous' }}</td>
            <td>{{ browser(s.user_agent) }}</td>
            <td><a class="btn" [routerLink]="['/projects', projectId, 'replays', s.session_id]">Play</a></td>
          </tr>
        }
      </tbody>
    </table></div>
    @if (loaded && !busy && !sessions.length) { <p class="muted" data-test="empty">No sessions for these filters.</p> }
    <div class="pager">
      <button type="button" (click)="page(-1)" [disabled]="offset === 0 || busy">Previous</button>
      <button type="button" (click)="page(1)" [disabled]="sessions.length < 50 || busy">Next</button>
    </div>
  `,
})
export class ReplaysComponent implements OnInit {
  private http = inject(HttpClient);
  private route = inject(ActivatedRoute);
  private cdr = inject(ChangeDetectorRef);

  projectId = '';
  filters: ReplayFilters = { page: '', errors: '', minDurationSec: null, maxDurationSec: null, environment: '' };
  sessions: ReplaySessionRow[] = [];
  enabled = true;
  loaded = false;
  busy = false;
  error = '';
  offset = 0;

  ngOnInit(): void {
    this.projectId = this.route.snapshot.paramMap.get('id') || '';
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
