import { ChangeDetectorRef, Component, ElementRef, HostListener, OnInit, ViewChild, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import DOMPurify from 'dompurify';
import {
  ClickHeatmapData,
  ScrollReachPoint,
  renderClickHeatmap,
  scrollBars,
  snapshotDocument,
  snapshotToHtml,
  viewportWidth,
} from './heatmap-render';

export interface HeatmapPage {
  page: string;
  clicks: number;
  views: number;
}

interface ClickResponse extends ClickHeatmapData {
  page: string;
  topTargets: Array<{ selector: string; count: number }>;
}

interface ScrollResponse {
  views: number;
  buckets: Array<{ depth: number; count: number }>;
  reach: ScrollReachPoint[];
}

type Viewport = 'all' | 'desktop' | 'tablet' | 'mobile';

/** Document aspect (height / width) for the neutral grid when no page snapshot is available. */
const GRID_ASPECT: Record<string, number> = { desktop: 1.6, all: 1.6, tablet: 2.2, mobile: 3.2 };

/**
 * Heatmaps: per-page click heatmap (canvas over the page snapshot from session replay when
 * available, else a neutral grid) and scroll-depth reach chart. Data is anonymous aggregates
 * from `GET /api/projects/:id/heatmaps`.
 */
@Component({
  selector: 'app-heatmaps',
  standalone: true,
  imports: [FormsModule, RouterLink],
  templateUrl: './heatmaps.component.html',
  styleUrls: ['./heatmaps.component.css'],
})
export class HeatmapsComponent implements OnInit {
  private http = inject(HttpClient);
  private route = inject(ActivatedRoute);
  private cdr = inject(ChangeDetectorRef);

  @ViewChild('stage') stageRef?: ElementRef<HTMLDivElement>;
  canvasRef?: ElementRef<HTMLCanvasElement>;
  /** The canvas appears with the first page (inside @if): size and draw it once it exists. */
  @ViewChild('heat') set heatCanvas(ref: ElementRef<HTMLCanvasElement> | undefined) {
    const appeared = !!ref && !this.canvasRef;
    this.canvasRef = ref;
    if (appeared) setTimeout(() => this.layout());
  }
  @ViewChild('frame') frameRef?: ElementRef<HTMLIFrameElement>;

  projectId = '';
  pages: HeatmapPage[] = [];
  page = '';
  viewport: Viewport = 'desktop';
  rangeDays = 7;
  readonly ranges = [1, 7, 30, 90];
  readonly viewports: Viewport[] = ['desktop', 'tablet', 'mobile', 'all'];

  loading = false;
  error = '';
  click: ClickResponse | null = null;
  scroll: ScrollResponse | null = null;
  bars: ReturnType<typeof scrollBars> = [];

  /** Background state: snapshot html loaded into the sandboxed frame, or the neutral grid. */
  background: 'grid' | 'snapshot' = 'grid';
  backgroundNote = '';
  replaySession = '';
  stageWidth = 0;
  stageHeight = 0;
  private scale = 1;
  private loadSeq = 0;

  ngOnInit(): void {
    this.projectId = this.route.snapshot.paramMap.get('id') || '';
    const q = this.route.snapshot.queryParamMap;
    if (q.get('page')) this.page = q.get('page')!;
    void this.loadPages();
  }

  @HostListener('window:resize')
  onResize(): void {
    this.layout();
  }

  private base(): string {
    return `/api/projects/${encodeURIComponent(this.projectId)}/heatmaps`;
  }

  private range(): { from: string; to: string } {
    const to = new Date();
    const from = new Date(to.getTime() - (this.rangeDays - 1) * 86_400_000);
    return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
  }

  async loadPages(): Promise<void> {
    this.error = '';
    try {
      const r = await firstValueFrom(this.http.get<{ pages: HeatmapPage[] }>(`${this.base()}/pages`, { params: { ...this.range(), viewport: this.viewport } }));
      this.pages = r.pages || [];
      if (!this.page || !this.pages.some((p) => p.page === this.page)) this.page = this.pages[0]?.page || this.page;
      if (this.page) await this.loadPage();
    } catch (e: any) {
      this.error = e?.error?.error || e?.message || 'Could not load heatmap pages';
    }
    this.cdr.markForCheck();
  }

  async loadPage(): Promise<void> {
    if (!this.page) return;
    const seq = ++this.loadSeq;
    this.loading = true;
    this.error = '';
    const params = { ...this.range(), viewport: this.viewport, page: this.page };
    try {
      const [click, scroll] = await Promise.all([
        firstValueFrom(this.http.get<ClickResponse>(this.base(), { params: { ...params, type: 'click' } })),
        firstValueFrom(this.http.get<ScrollResponse>(this.base(), { params: { ...params, type: 'scroll' } })),
      ]);
      if (seq !== this.loadSeq) return;
      this.click = click;
      this.scroll = scroll;
      this.bars = scrollBars(scroll.reach || []);
      await this.loadBackground(seq);
    } catch (e: any) {
      this.error = e?.error?.error || e?.message || 'Could not load heatmap';
    } finally {
      if (seq === this.loadSeq) this.loading = false;
      this.cdr.markForCheck();
      setTimeout(() => this.layout());
    }
  }

  /**
   * Page background from session replay (#40): `GET /api/projects/:id/replays/:sessionId/snapshot?page=`.
   * Uses the session typed in the toolbar, else `latest`: the API returns the newest full DOM
   * snapshot of this page (path or route name) from any session. A 404 means no consented
   * replay has recorded the page yet; any other failure (replay not installed) shows the grid too.
   */
  private async loadBackground(seq: number): Promise<void> {
    this.background = 'grid';
    this.backgroundNote = '';
    const pid = encodeURIComponent(this.projectId);
    const session = this.replaySession.trim() || 'latest';
    try {
      const body: any = await firstValueFrom(this.http.get(`/api/projects/${pid}/replays/${encodeURIComponent(session)}/snapshot`, { params: { page: this.page } }));
      if (seq !== this.loadSeq) return;
      const html = snapshotToHtml(body);
      if (!html) {
        this.backgroundNote = 'Replay snapshot not available — showing a neutral grid.';
        return;
      }
      // Defence in depth: DOMPurify strips scripts/handlers; the frame is sandboxed without
      // allow-scripts and the document carries a CSP that forbids scripts and connections.
      const clean = DOMPurify.sanitize(html, { WHOLE_DOCUMENT: true, FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'base'], ADD_TAGS: ['style'] });
      this.background = 'snapshot';
      this.cdr.detectChanges();
      const frame = this.frameRef?.nativeElement;
      if (frame) {
        frame.onload = () => this.layout();
        frame.srcdoc = snapshotDocument(String(clean));
      }
    } catch (err: any) {
      if (seq !== this.loadSeq) return;
      this.background = 'grid';
      this.backgroundNote =
        err?.status === 404
          ? 'No session replay has recorded this page yet — showing a neutral grid. The page appears once a visitor who allowed replay opens it.'
          : 'Session replay is not available — showing a neutral grid.';
    }
  }

  /** Size the stage: layout width per viewport, scaled to fit; height from the snapshot or the grid aspect. */
  layout(): void {
    const stage = this.stageRef?.nativeElement;
    const canvas = this.canvasRef?.nativeElement;
    if (!stage || !canvas) return;
    const avail = Math.max(240, (stage.parentElement?.clientWidth || 800) - 2);
    const layoutWidth = viewportWidth(this.viewport === 'all' ? 'desktop' : this.viewport);
    this.scale = Math.min(1, avail / layoutWidth);
    let docHeight = layoutWidth * (GRID_ASPECT[this.viewport] || 1.6);
    const frame = this.frameRef?.nativeElement;
    if (this.background === 'snapshot' && frame) {
      frame.style.width = `${layoutWidth}px`;
      try {
        const d = frame.contentDocument;
        const h = Math.max(d?.documentElement?.scrollHeight || 0, d?.body?.scrollHeight || 0);
        if (h > 0) docHeight = Math.min(h, 30_000);
      } catch {
        /* cross-origin (should not happen with srcdoc + allow-same-origin) */
      }
      frame.style.height = `${docHeight}px`;
      frame.style.transform = `scale(${this.scale})`;
    }
    this.stageWidth = Math.round(layoutWidth * this.scale);
    this.stageHeight = Math.round(docHeight * this.scale);
    stage.style.width = `${this.stageWidth}px`;
    stage.style.height = `${this.stageHeight}px`;
    canvas.width = this.stageWidth;
    canvas.height = this.stageHeight;
    renderClickHeatmap(canvas, this.click);
  }

  setViewport(v: Viewport): void {
    this.viewport = v;
    void this.loadPages();
  }

  setRange(days: number): void {
    this.rangeDays = days;
    void this.loadPages();
  }

  selectPage(page: string): void {
    this.page = page;
    void this.loadPage();
  }

  useSession(): void {
    void this.loadPage();
  }

  pct(n: number): string {
    return `${Math.round(n)}%`;
  }

  reachAt(depth: number): number {
    return this.scroll?.reach?.find((r) => r.depth === depth)?.pct ?? 0;
  }
}
