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
  /** rrweb-player (Svelte) prop update — used to resize with the stage. */
  $set?(props: Record<string, unknown>): void;
  triggerResize?(): void;
}

/** Player size for a stage width: 16:9, never wider than 1280 px. */
export function playerSize(stageWidth: number): { width: number; height: number } {
  const width = Math.max(200, Math.min(1280, Math.floor(stageWidth) || 960));
  return { width, height: Math.round(width * 0.5625) };
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
    app-replay-player { display: block; }
    app-replay-player .rpp-back { display: inline-block; margin-bottom: 12px; font-size: 0.875rem; color: rgb(var(--fg-2)); text-decoration: none; }
    app-replay-player .rpp-back:hover { color: rgb(var(--fg)); text-decoration: underline; }
    app-replay-player .rpp-title { overflow-wrap: anywhere; }
    app-replay-player .rpp-status { margin: 0 0 16px; font-size: 0.875rem; color: rgb(var(--fg-3)); }
    app-replay-player .rpp-notice {
      margin-bottom: 24px;
      padding: 12px 20px;
      border: 1px solid rgb(var(--line));
      border-left: 3px solid rgb(var(--down));
      border-radius: 10px;
      background: rgb(var(--surface));
      font-size: 0.875rem;
      color: rgb(var(--down));
    }
    app-replay-player .rpp-layout { display: flex; gap: 24px; align-items: flex-start; flex-wrap: wrap; }
    app-replay-player .rpp-stage { flex: 1 1 720px; min-width: 0; max-width: 100%; overflow: hidden; }
    /* The recording is the user's page and the rrweb controller sits on a white
       background in both themes: keep its text dark so it stays legible. */
    app-replay-player .rpp-stage .rr-player { background: #fff; max-width: 100%; }
    app-replay-player .rpp-stage .rr-controller { color: #18181b; max-width: 100%; }
    app-replay-player .rpp-stage .rr-controller__btns { flex-wrap: wrap; row-gap: 4px; }
    app-replay-player .rpp-stage .rr-controller__btns button { color: #3f3f46; }
    app-replay-player .rpp-stage .rr-controller__btns button.active { color: #fff; }
    app-replay-player .rpp-stage .rr-controller__btns button:disabled { color: #a1a1aa; }
    app-replay-player .rpp-stage .switch .label { color: #3f3f46; }
    app-replay-player .rpp-timeline { flex: 0 1 360px; min-width: 0; max-height: 640px; overflow: auto; }
    app-replay-player .rpp-marker { display: flex; gap: 8px; padding: 8px 20px; border-bottom: 1px solid rgb(var(--line)); font-size: 0.8125rem; }
    app-replay-player .rpp-marker:last-child { border-bottom: 0; }
    app-replay-player .rpp-seek {
      flex: none;
      padding: 0;
      border: 0;
      background: none;
      color: rgb(var(--accent-text));
      font-family: 'IBM Plex Mono', ui-monospace, monospace;
      font-size: 0.8125rem;
      font-variant-numeric: tabular-nums;
      cursor: pointer;
    }
    app-replay-player .rpp-seek:hover { text-decoration: underline; }
    app-replay-player .rpp-kind { flex: none; color: rgb(var(--fg-2)); }
    app-replay-player .k-error { color: rgb(var(--down)); }
    app-replay-player .k-network { color: rgb(var(--warn)); }
    app-replay-player .k-navigation { color: rgb(var(--info)); }
    app-replay-player .rpp-label { min-width: 0; overflow-wrap: anywhere; color: rgb(var(--fg)); }
    app-replay-player .rpp-label a { margin-left: 6px; }
  `],
  template: `
    <a class="rpp-back" [routerLink]="['/projects', projectId]" [queryParams]="{ tab: 'monitoring', view: 'users' }">Back to sessions</a>
    @if (detail; as d) {
      <div class="page-header">
        <div>
          <h1 class="page-title rpp-title">Session <span class="mono">{{ d.session.session_id }}</span></h1>
          <p class="page-subtitle">
            {{ d.session.started_at | date:'medium' }} · {{ duration(d.session.duration_ms) }} · {{ d.session.pages.length }} {{ d.session.pages.length === 1 ? 'page' : 'pages' }}
            · {{ browser(d.session.user_agent) }} · user {{ d.session.user_id || 'anonymous' }}
            @if (d.session.environment) { · {{ d.session.environment }} }
            @if (d.session.release) { · {{ d.session.release }} }
          </p>
        </div>
      </div>
    }
    @if (error) { <div class="rpp-notice" role="alert">{{ error }}</div> }
    @if (loading) { <p class="rpp-status" data-test="loading">Loading recording… {{ progress }}</p> }
    <div class="rpp-layout">
      <div class="rpp-stage"><div #stage data-test="stage"></div></div>
      @if (markers.length || (detail?.errors?.length ?? 0)) {
        <aside class="card card-flush rpp-timeline" aria-labelledby="rpp-timeline-title">
          <div class="card-header">
            <h2 id="rpp-timeline-title">Timeline</h2>
            <span class="badge">{{ markers.length }}</span>
          </div>
          @for (m of markers; track $index) {
            <div class="rpp-marker" data-test="marker">
              <button type="button" class="rpp-seek" (click)="seek(m)">{{ offset(m.offsetMs) }}</button>
              <span class="rpp-kind" [class]="'rpp-kind k-' + m.kind">{{ m.kind }}</span>
              <span class="rpp-label">{{ m.label }}
                @if (m.issueId) { <a [routerLink]="['/projects', projectId]" [queryParams]="{ tab: 'monitoring', view: 'errors', issue: m.issueId }">Issue</a> }
                @if (m.traceId) { <a [href]="trace(m.traceId)" target="_blank" rel="noopener">Trace</a> }
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
  private resizeObserver: ResizeObserver | null = null;
  private lastWidth = 0;

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
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
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
      const size = playerSize(this.stage.nativeElement.clientWidth);
      this.lastWidth = size.width;
      this.player = create(this.stage.nativeElement, {
        events,
        width: size.width,
        height: size.height,
        autoPlay: false,
        showController: true,
        skipInactive: true,
        mouseTail: false,
        // Error / network / navigation markers on the progress bar.
        tags: { error: '#ef4444', network: '#f59e0b', navigation: '#3b82f6' },
        // Recorded pages render in a sandboxed iframe without scripts.
        UNSAFE_replayCanvas: false,
      });
      this.observeStage();
    } catch (e: any) {
      this.error = e?.status === 404 ? 'Replay not found (it may have been deleted after the retention period).'
        : e?.status === 403 ? 'You need access to this project to view its replays.'
        : 'Could not load the replay.';
    } finally {
      this.loading = false;
      this.cdr.markForCheck();
    }
  }

  /** Follow the stage width (window resize, sidebar toggle, rotation). */
  private observeStage(): void {
    if (typeof ResizeObserver === 'undefined' || this.resizeObserver) return;
    this.resizeObserver = new ResizeObserver((entries) => this.resize(entries[0]?.contentRect.width ?? 0));
    this.resizeObserver.observe(this.stage.nativeElement);
  }

  /** Resize the player to a new stage width (no-op for sub-pixel jitter). */
  resize(stageWidth: number): void {
    if (!this.player || !stageWidth) return;
    const size = playerSize(stageWidth);
    if (Math.abs(size.width - this.lastWidth) < 2) return;
    this.lastWidth = size.width;
    try {
      this.player.$set?.(size);
      this.player.triggerResize?.();
    } catch {
      /* ignore */
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
