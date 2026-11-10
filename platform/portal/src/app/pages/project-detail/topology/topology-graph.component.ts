import {
  Component, ElementRef, EventEmitter, HostListener, Input, OnChanges, OnDestroy, OnInit, Output,
  SimpleChanges, ViewChild, inject, ChangeDetectorRef,
} from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { DEFAULT_LAYOUT, LayoutResult, layoutGraph } from './topology-layout';

export interface TopologyNode {
  id: string;
  kind: string;
  name: string;
  health: string | null;
  sync: string | null;
  info: Record<string, any>;
  events: Array<{ type: string; reason: string; message: string; count: number; lastTimestamp: string | null }>;
}
export interface TopologyEdge { from: string; to: string; type: 'owns' | 'routes' | 'selects' }
export interface TopologyResponse {
  namespace: string;
  appName: string;
  environmentId: string;
  environment: string;
  argo: { found: boolean; error: string | null; sync: string | null; health: string | null; revision: string | null };
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  counts: Record<string, number>;
  warnings?: string[];
  generatedAt: string;
}

export const TOPOLOGY_REFRESH_MS = 10_000;

const KIND_ABBR: Record<string, string> = {
  Application: 'app', Deployment: 'deploy', ReplicaSet: 'rs', Pod: 'pod', Service: 'svc', Ingress: 'ing',
  Certificate: 'cert', PersistentVolumeClaim: 'pvc', ConfigMap: 'cm', Secret: 'secret',
  HorizontalPodAutoscaler: 'hpa', ServiceAccount: 'sa', StatefulSet: 'sts', DaemonSet: 'ds', Job: 'job', CronJob: 'cj',
};

/**
 * Live, read-only resource graph of one project environment (issue #31):
 * Argo Application resources + namespace objects from
 * GET /api/projects/:projectId/environments/:envId/topology.
 * Hand-rolled SVG + layered layout (no graph dependency); colours come from the
 * theme CSS variables. Refreshes every 10 s while the browser tab is visible.
 */
@Component({
  selector: 'app-topology-graph',
  standalone: true,
  imports: [],
  templateUrl: './topology-graph.component.html',
  styleUrl: './topology-graph.component.css',
})
export class TopologyGraphComponent implements OnInit, OnChanges, OnDestroy {
  private http = inject(HttpClient);
  private cdr = inject(ChangeDetectorRef);

  @Input({ required: true }) projectId!: string;
  @Input() environments: Array<{ id: string; name: string }> = [];
  /** Emitted for "View logs" on a pod node; the parent opens its log viewer. */
  @Output() podLogs = new EventEmitter<{ name: string; namespace: string }>();

  @ViewChild('viewport') viewport?: ElementRef<HTMLDivElement>;

  readonly nodeW = DEFAULT_LAYOUT.nodeWidth;
  readonly nodeH = DEFAULT_LAYOUT.nodeHeight;
  refreshMs = TOPOLOGY_REFRESH_MS;

  envId = '';
  data: TopologyResponse | null = null;
  layout: LayoutResult | null = null;
  loading = false;
  error: string | null = null;
  selectedId: string | null = null;
  lastUpdated: Date | null = null;

  // pan / zoom
  tx = 20;
  ty = 20;
  scale = 1;
  private needsFit = true;
  private drag: { x: number; y: number; tx: number; ty: number; moved: boolean } | null = null;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private destroyed = false;
  private readonly onVisibility = () => {
    if (document.visibilityState === 'visible') this.refresh();
    else this.clearTimer();
  };

  ngOnInit(): void {
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['environments'] || changes['projectId']) {
      const ids = (this.environments || []).map((e) => e.id);
      if (!this.envId || !ids.includes(this.envId)) {
        this.envId = this.defaultEnvId();
        this.resetView();
      }
      this.refresh();
    }
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.clearTimer();
    document.removeEventListener('visibilitychange', this.onVisibility);
  }

  private defaultEnvId(): string {
    const envs = this.environments || [];
    return (envs.find((e) => e.name === 'staging') || envs.find((e) => e.name === 'production') || envs[0])?.id || '';
  }

  selectEnv(id: string): void {
    if (id === this.envId) return;
    this.envId = id;
    this.resetView();
    this.refresh();
  }

  private resetView(): void {
    this.data = null;
    this.layout = null;
    this.error = null;
    this.selectedId = null;
    this.needsFit = true;
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    this.clearTimer();
    if (this.destroyed || typeof document === 'undefined' || document.visibilityState !== 'visible') return;
    this.timer = setTimeout(() => this.refresh(), this.refreshMs);
  }

  /** Fetch now and schedule the next poll (only while the tab is visible). */
  async refresh(): Promise<void> {
    if (this.destroyed || !this.projectId || !this.envId) {
      this.clearTimer();
      return;
    }
    if (this.inFlight) return;
    this.inFlight = true;
    this.clearTimer();
    this.loading = true;
    const envId = this.envId;
    try {
      const res = await firstValueFrom(
        this.http.get<TopologyResponse>(`/api/projects/${encodeURIComponent(this.projectId)}/environments/${encodeURIComponent(envId)}/topology`),
      );
      if (envId !== this.envId || this.destroyed) return;
      this.apply(res);
      this.error = null;
      this.lastUpdated = new Date();
    } catch (err: any) {
      if (envId !== this.envId || this.destroyed) return;
      this.error = err?.error?.error || err?.message || 'Failed to load topology';
    } finally {
      this.inFlight = false;
      this.loading = false;
      this.schedule();
      this.cdr.markForCheck();
    }
  }

  private apply(res: TopologyResponse): void {
    this.data = res;
    this.layout = layoutGraph(res.nodes || [], res.edges || []);
    if (this.selectedId && !res.nodes.some((n) => n.id === this.selectedId)) this.selectedId = null;
    if (this.needsFit && res.nodes.length) {
      this.needsFit = false;
      // After render so the viewport has its size.
      setTimeout(() => this.fit(), 0);
    }
  }

  // ── view helpers ────────────────────────────────────────────────────────────

  get nodes(): TopologyNode[] { return this.data?.nodes || []; }
  get edges(): TopologyEdge[] { return this.data?.edges || []; }
  get selected(): TopologyNode | null { return this.nodes.find((n) => n.id === this.selectedId) || null; }

  get countSummary(): Array<{ kind: string; count: number }> {
    const c = this.data?.counts || {};
    return Object.keys(c).sort().map((kind) => ({ kind, count: c[kind] }));
  }

  get degradedCount(): number { return this.nodes.filter((n) => n.health === 'Degraded').length; }
  get outOfSyncCount(): number { return this.nodes.filter((n) => n.sync === 'OutOfSync').length; }

  x(id: string): number { return this.layout?.nodes.get(id)?.x ?? 0; }
  y(id: string): number { return this.layout?.nodes.get(id)?.y ?? 0; }
  edgePath(i: number): string { return this.layout?.edges[i]?.path || ''; }

  abbr(kind: string): string { return KIND_ABBR[kind] || kind.toLowerCase(); }

  short(name: string, max = 26): string {
    return name.length > max ? `${name.slice(0, max - 1)}…` : name;
  }

  healthClass(n: TopologyNode): string {
    return `h-${(n.health || 'none').toLowerCase()}`;
  }

  statusLine(n: TopologyNode): string {
    const i = n.info || {};
    if (n.kind === 'Deployment' || n.kind === 'ReplicaSet') return `${i['readyReplicas'] ?? 0}/${i['replicas'] ?? 0} ready`;
    if (n.kind === 'Pod') return `${i['ready'] ?? ''}${i['reason'] ? ' · ' + i['reason'] : ''}${i['restarts'] ? ' · ' + i['restarts'] + '↻' : ''}`;
    if (n.kind === 'Service') return `${i['type'] ?? ''} · ${i['endpoints'] ?? 0} pods`;
    if (n.kind === 'Ingress') return (i['hosts'] || [])[0] || '';
    if (n.kind === 'PersistentVolumeClaim') return `${i['phase'] ?? ''}${i['capacity'] ? ' · ' + i['capacity'] : ''}`;
    if (n.kind === 'Application') return i['targetRevision'] ? `@ ${i['targetRevision']}` : '';
    return n.health || '';
  }

  infoEntries(n: TopologyNode): Array<{ key: string; value: string }> {
    return Object.entries(n.info || {})
      .filter(([, v]) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0))
      .map(([key, v]) => ({ key, value: this.fmt(v) }));
  }

  private fmt(v: any): string {
    if (Array.isArray(v)) return v.map((x) => (typeof x === 'object' ? this.fmt(x) : String(x))).join(', ');
    if (v && typeof v === 'object') return Object.entries(v).map(([k, x]) => `${k}=${typeof x === 'object' ? JSON.stringify(x) : x}`).join(', ');
    return String(v);
  }

  // ── interaction ─────────────────────────────────────────────────────────────

  select(n: TopologyNode, ev?: Event): void {
    ev?.stopPropagation();
    if (this.drag?.moved) return;
    this.selectedId = this.selectedId === n.id ? null : n.id;
  }

  closeDrawer(): void { this.selectedId = null; }

  /** Background click closes the drawer, unless the gesture was a pan. */
  onBackgroundClick(): void {
    if (!this.drag?.moved) this.selectedId = null;
  }

  openLogs(n: TopologyNode): void {
    if (n.kind !== 'Pod' || !this.data) return;
    this.podLogs.emit({ name: n.name, namespace: this.data.namespace });
  }

  @HostListener('document:keydown.escape')
  onEscape(): void { this.selectedId = null; }

  zoomBy(factor: number, cx?: number, cy?: number): void {
    const el = this.viewport?.nativeElement;
    const px = cx ?? (el ? el.clientWidth / 2 : 0);
    const py = cy ?? (el ? el.clientHeight / 2 : 0);
    const next = Math.min(2.5, Math.max(0.15, this.scale * factor));
    const k = next / this.scale;
    this.tx = px - (px - this.tx) * k;
    this.ty = py - (py - this.ty) * k;
    this.scale = next;
  }

  fit(): void {
    const el = this.viewport?.nativeElement;
    if (!el || !this.layout || !this.layout.nodes.size) return;
    const pad = 24;
    const w = Math.max(1, el.clientWidth - pad * 2);
    const h = Math.max(1, el.clientHeight - pad * 2);
    const gw = Math.max(1, this.layout.width);
    const gh = Math.max(1, this.layout.height);
    this.scale = Math.min(1.2, Math.max(0.15, Math.min(w / gw, h / gh)));
    this.tx = pad + (w - gw * this.scale) / 2;
    this.ty = pad + (h - gh * this.scale) / 2;
    this.cdr.markForCheck();
  }

  onWheel(ev: WheelEvent): void {
    ev.preventDefault();
    const rect = this.viewport?.nativeElement.getBoundingClientRect();
    const factor = ev.deltaY < 0 ? 1.1 : 1 / 1.1;
    this.zoomBy(factor, rect ? ev.clientX - rect.left : undefined, rect ? ev.clientY - rect.top : undefined);
  }

  onPointerDown(ev: PointerEvent): void {
    if (ev.button !== 0) return;
    this.drag = { x: ev.clientX, y: ev.clientY, tx: this.tx, ty: this.ty, moved: false };
  }

  onPointerMove(ev: PointerEvent): void {
    if (!this.drag) return;
    const dx = ev.clientX - this.drag.x;
    const dy = ev.clientY - this.drag.y;
    if (!this.drag.moved && Math.abs(dx) + Math.abs(dy) > 4) {
      this.drag.moved = true;
      (ev.currentTarget as Element | null)?.setPointerCapture?.(ev.pointerId);
    }
    if (this.drag.moved) {
      this.tx = this.drag.tx + dx;
      this.ty = this.drag.ty + dy;
    }
  }

  onPointerUp(ev: PointerEvent): void {
    const d = this.drag;
    (ev.currentTarget as Element | null)?.releasePointerCapture?.(ev.pointerId);
    // Let the click handler see `moved` for this gesture, then clear.
    setTimeout(() => { if (this.drag === d) this.drag = null; }, 0);
  }

  onNodeKey(n: TopologyNode, ev: KeyboardEvent): void {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      this.select(n);
    }
  }

  trackNode = (_: number, n: TopologyNode) => n.id;
}
