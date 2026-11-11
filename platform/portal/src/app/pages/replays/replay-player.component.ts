import { ChangeDetectorRef, Component, ElementRef, OnDestroy, OnInit, ViewChild, ViewEncapsulation, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import {
  browserLabel,
  formatDuration,
  formatOffset,
  mergeChunkEvents,
  ReplayErrorRow,
  ReplayMarker,
  replayMarkers,
  ReplaySessionRow,
  traceUrl,
} from './replay-utils';

interface SessionDetail {
  session: ReplaySessionRow;
  chunks: Array<{ seq: number; bytes: number; event_count: number; started_at: string; ended_at: string }>;
  errors: ReplayErrorRow[];
}

/** Minimal surface of rrweb-player used here (the module is lazy-loaded). */
export interface ReplayPlayerLike {
  goto(timeOffset: number, play?: boolean): void;
  pause?(): void;
  $destroy?(): void;
}
export type PlayerFactory = (target: HTMLElement, props: Record<string, unknown>) => ReplayPlayerLike;

/** rrweb-player is only downloaded when a replay is opened (separate lazy chunk). */
export async function loadRrwebPlayer(): Promise<PlayerFactory> {
  const mod: any = await import('rrweb-player');
  const Player = mod.default || mod;
  return (target, props) => new Player({ target, props });
}

const CONCURRENCY = 4;

/** Session replay player (#40): rrweb-player with error / network / navigation markers. */
@Component({
  selector: 'app-replay-player',
  standalone: true,
  imports: [RouterLink, DatePipe],
  // rrweb-player renders outside Angular's view; its stylesheet must be global to apply.
  encapsulation: ViewEncapsulation.None,
  styleUrls: ['../../../../node_modules/rrweb-player/dist/style.css'],
  styles: [`
    app-replay-player { display: block; padding: 24px; color: #e4e4e7; }
    app-replay-player h1 { font-size: 20px; margin: 8px 0 4px; }
    app-replay-player .muted { color: #a1a1aa; font-size: 13px; }
    app-replay-player .layout { display: flex; gap: 20px; align-items: flex-start; flex-wrap: wrap; margin-top: 16px; }
    app-replay-player .stage { flex: 1 1 720px; min-width: 320px; }
    app-replay-player .stage .rr-player { background: #fff; }
    app-replay-player aside { flex: 0 1 360px; max-height: 640px; overflow: auto; border: 1px solid #27272a; border-radius: 8px; }
    app-replay-player aside h2 { font-size: 13px; color: #a1a1aa; margin: 0; padding: 10px 12px; border-bottom: 1px solid #27272a; }
    app-replay-player .marker { display: flex; gap: 8px; padding: 8px 12px; border-bottom: 1px solid #18181b; font-size: 12px; }
    app-replay-player .marker button.seek { background: none; border: 0; color: #93c5fd; cursor: pointer; padding: 0; font-variant-numeric: tabular-nums; }
    app-replay-player .marker .k-error { color: #f87171; }
    app-replay-player .marker .k-network { color: #fbbf24; }
    app-replay-player .marker .k-navigation { color: #60a5fa; }
    app-replay-player .marker a { color: #a5b4fc; }
    app-replay-player .label { overflow-wrap: anywhere; }
    app-replay-player a.btn { background: #18181b; border: 1px solid #3f3f46; color: #e4e4e7; border-radius: 6px; padding: 6px 10px; text-decoration: none; font-size: 13px; }
    app-replay-player .notice { border: 1px solid #3f3f46; border-radius: 8px; padding: 12px 14px; margin: 12px 0; background: #111; font-size: 13px; }
    app-replay-player .err { color: #f87171; }
  `],
  template: `
    <a class="btn" [routerLink]="['/projects', projectId, 'replays']">&larr; Sessions</a>
    @if (detail; as d) {
      <h1>Session {{ d.session.session_id }}</h1>
      <p class="muted">
        {{ d.session.started_at | date:'medium' }} · {{ duration(d.session.duration_ms) }} · {{ d.session.pages.length }} page(s)
        · {{ browser(d.session.user_agent) }} · user {{ d.session.user_id || 'anonymous' }}
        @if (d.session.environment) { · {{ d.session.environment }} }
        @if (d.session.release) { · {{ d.session.release }} }
      </p>
    }
    @if (error) { <div class="notice err" role="alert">{{ error }}</div> }
    @if (loading) { <p class="muted" data-test="loading">Loading recording… {{ progress }}</p> }
    <div class="layout">
      <div class="stage"><div #stage data-test="stage"></div></div>
      @if (markers.length || (detail?.errors?.length ?? 0)) {
        <aside>
          <h2>Timeline ({{ markers.length }})</h2>
          @for (m of markers; track $index) {
            <div class="marker" data-test="marker">
              <button type="button" class="seek" (click)="seek(m)">{{ offset(m.offsetMs) }}</button>
              <span [class]="'k-' + m.kind">{{ m.kind }}</span>
              <span class="label">{{ m.label }}
                @if (m.issueId) { <a [routerLink]="['/projects', projectId, 'errors']" [queryParams]="{ issue: m.issueId }">issue</a> }
                @if (m.traceId) { <a [href]="trace(m.traceId)" target="_blank" rel="noopener">trace</a> }
              </span>
            </div>
          }
        </aside>
      }
    </div>
  `,
})
export class ReplayPlayerComponent implements OnInit, OnDestroy {
  private http = inject(HttpClient);
  private route = inject(ActivatedRoute);
  private cdr = inject(ChangeDetectorRef);

  @ViewChild('stage', { static: true }) stage!: ElementRef<HTMLElement>;

  /** Overridable in tests. */
  playerFactory: () => Promise<PlayerFactory> = loadRrwebPlayer;

  projectId = '';
  sessionId = '';
  detail: SessionDetail | null = null;
  markers: ReplayMarker[] = [];
  loading = false;
  progress = '';
  error = '';
  private player: ReplayPlayerLike | null = null;
  private destroyed = false;

  duration = formatDuration;
  browser = browserLabel;
  offset = formatOffset;
  trace = traceUrl;

  ngOnInit(): void {
    this.projectId = this.route.snapshot.paramMap.get('id') || '';
    this.sessionId = this.route.snapshot.paramMap.get('sessionId') || '';
    void this.load();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    try {
      this.player?.pause?.();
      this.player?.$destroy?.();
    } catch {
      /* ignore */
    }
    this.player = null;
  }

  private base(): string {
    return `/api/projects/${encodeURIComponent(this.projectId)}/replays/${encodeURIComponent(this.sessionId)}`;
  }

  async load(): Promise<void> {
    this.loading = true;
    this.error = '';
    try {
      this.detail = await firstValueFrom(this.http.get<SessionDetail>(this.base()));
      const chunks = this.detail.chunks || [];
      const envelopes: Array<{ seq: number; events?: any[] } | null> = new Array(chunks.length).fill(null);
      let next = 0;
      let done = 0;
      const worker = async () => {
        while (next < chunks.length && !this.destroyed) {
          const i = next++;
          try {
            const env = await firstValueFrom(this.http.get<any>(`${this.base()}/chunks/${chunks[i].seq}`));
            envelopes[i] = { seq: chunks[i].seq, events: Array.isArray(env?.events) ? env.events : [] };
          } catch {
            envelopes[i] = null; // expired or unreadable chunk: play the rest
          }
          done++;
          this.progress = `${done}/${chunks.length}`;
          this.cdr.markForCheck();
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker));
      if (this.destroyed) return;
      const events = mergeChunkEvents(envelopes);
      this.markers = replayMarkers(events, this.detail.errors || []);
      if (!events.some((e) => e.type === 2)) {
        this.error = 'This recording has no full page snapshot (its first chunks expired or were not uploaded), so it cannot be played.';
        return;
      }
      const create = await this.playerFactory();
      if (this.destroyed) return;
      const width = Math.max(320, Math.min(1280, this.stage.nativeElement.clientWidth || 960));
      this.player = create(this.stage.nativeElement, {
        events,
        width,
        height: Math.round(width * 0.5625),
        autoPlay: false,
        showController: true,
        skipInactive: true,
        mouseTail: false,
        // Error / network / navigation markers on the progress bar.
        tags: { error: '#ef4444', network: '#f59e0b', navigation: '#3b82f6' },
        // Recorded pages render in a sandboxed iframe without scripts.
        UNSAFE_replayCanvas: false,
      });
    } catch (e: any) {
      this.error = e?.status === 404 ? 'Replay not found (it may have been deleted after the retention period).'
        : e?.status === 403 ? 'You need access to this project to view its replays.'
        : 'Could not load the replay.';
    } finally {
      this.loading = false;
      this.cdr.markForCheck();
    }
  }

  seek(m: ReplayMarker): void {
    try {
      this.player?.goto(Math.max(0, m.offsetMs - 2000), false);
    } catch {
      /* ignore */
    }
  }
}
