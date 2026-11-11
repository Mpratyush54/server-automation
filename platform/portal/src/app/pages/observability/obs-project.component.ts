import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { firstValueFrom, Subscription } from 'rxjs';
import {
  DEFAULT_SINCE, Flamebearer, fmtBytes, fmtMs, fmtPct, fmtRate, GraphEdge, GraphNode, healthLabel, isProjectTab, isSince, nsToDate, Point,
  PROJECT_TABS, projectBase, ProjectTab, SINCE_OPTIONS,
  humanizeStatus,
} from './observability-api';
import { ChartMarker, ChartSeries, ObsLineChartComponent } from './obs-line-chart.component';
import { ObsTraceViewComponent } from './obs-trace-view.component';
import { ObsLogsComponent } from './obs-logs.component';
import { ObsServiceMapComponent } from './obs-service-map.component';
import { ObsFlamegraphComponent } from './obs-flamegraph.component';

/** Web vitals reported by the RUM SDKs (#39) through Faro measurements. */
export const WEB_VITALS = ['lcp', 'inp', 'cls', 'fcp', 'ttfb'] as const;

/** LogQL for the p75 of one web vital by page (scoped to the project by the API). */
export function webVitalQuery(vital: string, seconds: number): string {
  return `quantile_over_time(0.75, {} | logfmt | kind="measurement" | ${vital}!="" | unwrap ${vital} | __error__="" [${Math.max(60, Math.floor(seconds))}s]) by (page_url)`;
}

const SINCE_SECONDS: Record<string, number> = { '15m': 900, '1h': 3600, '6h': 21600, '24h': 86400, '7d': 604800 };

/**
 * Per-project Observability (#48): Overview (RED + Apdex, deploy markers),
 * APM (services, endpoints, service map), Traces (search + waterfall), Logs
 * (filters / LogQL, live tail, trace links), Errors, RUM, Sessions,
 * Synthetics, Infra, Profiles. Tab, time range, environment and the open
 * trace live in the URL.
 */
@Component({
  selector: 'app-obs-project',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule, ObsLineChartComponent, ObsTraceViewComponent, ObsLogsComponent, ObsServiceMapComponent, ObsFlamegraphComponent],
  styleUrls: ['./obs-theme.css'],
  styles: [`h1 { margin: 0; } .head { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; flex-wrap: wrap; margin-bottom: 12px; } .back { font-size: 0.85rem; } .search { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; align-items: end; } .search label { display: flex; flex-direction: column; gap: 4px; font-size: 0.78rem; color: var(--obs-muted); } textarea.obs-input { width: 100%; box-sizing: border-box; min-height: 48px; }`],
  templateUrl: './obs-project.component.html',
})
export class ObsProjectComponent implements OnInit, OnDestroy {
  private http = inject(HttpClient);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private sub?: Subscription;

  readonly tabs = PROJECT_TABS;
  readonly sinceOptions = SINCE_OPTIONS;
  readonly humanize = humanizeStatus;
  readonly vitals = WEB_VITALS;
  readonly rate = fmtRate;
  readonly pct = fmtPct;
  readonly ms = fmtMs;
  readonly bytes = fmtBytes;
  readonly healthLabel = healthLabel;

  projectId = '';
  projectName = '';
  tab: ProjectTab = 'overview';
  since = DEFAULT_SINCE;
  environment = '';
  environments: string[] = [];
  enabled: boolean | null = null;
  error = '';
  loading = false;

  summary: any = null;
  redSeries: { rate: ChartSeries[]; errors: ChartSeries[]; latency: ChartSeries[] } = { rate: [], errors: [], latency: [] };
  markers: ChartMarker[] = [];

  services: any[] = [];
  endpoints: any[] = [];
  selectedService = '';
  graph: { nodes: GraphNode[]; edges: GraphEdge[] } = { nodes: [], edges: [] };

  traceForm = { service: '', name: '', minDuration: '', status: '', q: '' };
  traceMode: 'filters' | 'traceql' = 'filters';
  traces: any[] = [];
  tracesLoaded = false;
  openTraceId = '';

  logTraceId = '';
  logQuery = '';

  infra: { cpu: ChartSeries[]; memory: ChartSeries[]; restarts: any[]; namespaces: string[] } = { cpu: [], memory: [], restarts: [], namespaces: [] };

  profileMeta: { services: string[]; profileTypes: string[] } = { services: [], profileTypes: [] };
  profileService = '';
  profileType = '';
  flame: { flamebearer: Flamebearer | null; units: string | null } = { flamebearer: null, units: null };

  rum: Array<{ page: string; values: Record<string, number | null> }> = [];
  rumLoaded = false;

  replaysAvailable = false;

  readonly onErr = (e: any) => { this.error = e?.error?.error || 'Request failed.'; };
  readonly done = () => { this.loading = false; };

  async ngOnInit() {
    this.projectId = this.route.snapshot?.paramMap?.get('id') || '';
    this.replaysAvailable = (this.router.config || []).some((r) => r.path === 'projects/:id/replays' || r.path === 'projects/:id/sessions');
    this.readUrl();
    await this.loadStatic();
    await this.loadTab();
    this.sub = this.route.queryParamMap?.subscribe?.(() => {
      const before = `${this.tab}|${this.since}|${this.environment}|${this.openTraceId}`;
      this.readUrl();
      if (`${this.tab}|${this.since}|${this.environment}|${this.openTraceId}` !== before) void this.loadTab();
    });
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }

  private readUrl() {
    const qp = this.route.snapshot?.queryParamMap;
    const tab = qp?.get('tab');
    this.tab = isProjectTab(tab) ? tab : 'overview';
    const since = qp?.get('since');
    this.since = isSince(since) ? since! : DEFAULT_SINCE;
    this.environment = qp?.get('env') || '';
    this.openTraceId = /^[0-9a-f]{16,32}$/i.test(qp?.get('trace') || '') ? qp!.get('trace')! : '';
    this.logTraceId = /^[0-9a-f]{16,32}$/i.test(qp?.get('logTrace') || '') ? qp!.get('logTrace')! : '';
    this.selectedService = qp?.get('service') || '';
  }

  /** Update URL state (tab, range, environment, open trace...). */
  setState(patch: Record<string, string | null>) {
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'tab' && isProjectTab(v)) this.tab = v;
      if (k === 'since' && v && isSince(v)) this.since = v;
      if (k === 'env') this.environment = v || '';
      if (k === 'trace') this.openTraceId = v || '';
      if (k === 'logTrace') this.logTraceId = v || '';
      if (k === 'service') this.selectedService = v || '';
    }
    this.router.navigate([], { relativeTo: this.route, queryParams: patch, queryParamsHandling: 'merge', replaceUrl: false });
    void this.loadTab();
  }

  base(): string {
    return projectBase(this.projectId);
  }

  params(extra: Record<string, string> = {}): Record<string, string> {
    const p: Record<string, string> = { since: this.since, ...extra };
    if (this.environment) p['environment'] = this.environment;
    return p;
  }

  private async get<T = any>(path: string, params: Record<string, string> = {}): Promise<T> {
    return firstValueFrom(this.http.get<T>(`${this.base()}${path}`, { params }));
  }

  async loadStatic() {
    try {
      const status: any = await firstValueFrom(this.http.get('/api/observability/status'));
      this.enabled = !!status?.enabled;
    } catch {
      this.enabled = false;
    }
    try {
      const project: any = await firstValueFrom(this.http.get(`/api/projects/${encodeURIComponent(this.projectId)}`));
      this.projectName = project?.name || '';
      this.environments = (project?.environments || []).map((e: any) => String(e.name)).filter(Boolean);
    } catch { /* name is cosmetic */ }
  }

  async loadTab() {
    this.error = '';
    this.loading = true;
    try {
      switch (this.tab) {
        case 'overview': await this.loadOverview(); break;
        case 'errors': case 'synthetics': case 'sessions': await this.loadSummary(); break;
        case 'apm': if (this.enabled) await this.loadApm(); break;
        case 'traces': if (this.enabled && !this.openTraceId) await this.searchTraces(); break;
        case 'infra': if (this.enabled) await this.loadInfra(); break;
        case 'profiles': if (this.enabled) await this.loadProfiles(); break;
        case 'rum': if (this.enabled) await this.loadRum(); break;
        default: break;
      }
    } catch (e: any) {
      this.error = e?.error?.error || 'Could not load this view.';
    } finally {
      this.loading = false;
    }
  }

  async loadSummary() {
    this.summary = await this.get('/summary', this.params());
  }

  async loadOverview() {
    await this.loadSummary();
    if (!this.enabled) return;
    const [red, releases] = await Promise.all([
      this.get('/red', this.params()),
      firstValueFrom(this.http.get<any[]>(`/api/projects/${encodeURIComponent(this.projectId)}/releases`)).catch(() => [] as any[]),
    ]);
    this.redSeries = {
      rate: [{ name: 'Requests', points: red.requestRate || [] }],
      errors: [{ name: 'Error rate', points: red.errorRate || [], color: 'var(--obs-bad)' }],
      latency: [{ name: 'p95', points: red.p95Ms || [] }],
    };
    this.markers = (Array.isArray(releases) ? releases : [])
      .filter((r: any) => r.markerAt && (!this.environment || r.environment?.name === this.environment || !r.environment))
      .map((r: any) => ({ t: new Date(r.markerAt).getTime() / 1000, label: `Deploy ${r.release || r.version || ''}`.trim() }));
  }

  async loadApm() {
    const [svc, graph] = await Promise.all([this.get('/services', this.params()), this.get('/service-graph', this.params())]);
    this.services = svc.services || [];
    this.graph = { nodes: graph.nodes || [], edges: graph.edges || [] };
    await this.loadEndpoints();
  }

  async loadEndpoints() {
    const res = await this.get('/endpoints', this.params(this.selectedService ? { service: this.selectedService } : {}));
    this.endpoints = res.endpoints || [];
  }

  selectService(name: string) {
    this.setState({ service: this.selectedService === name ? null : name });
  }

  async searchTraces() {
    const p = this.traceMode === 'traceql' && this.traceForm.q.trim()
      ? this.params({ q: this.traceForm.q.trim(), limit: '50' })
      : this.params(Object.fromEntries(Object.entries({ service: this.traceForm.service, name: this.traceForm.name, minDuration: this.traceForm.minDuration, status: this.traceForm.status, limit: '50' }).filter(([, v]) => v)) as Record<string, string>);
    try {
      const res = await this.get('/query/tempo', p);
      this.traces = res.traces || [];
    } finally {
      this.tracesLoaded = true;
    }
  }

  openTrace(id: string) {
    this.setState({ tab: 'traces', trace: id });
  }

  closeTrace() {
    this.setState({ trace: null });
  }

  logsForTrace(id: string) {
    this.setState({ tab: 'logs', logTrace: id, trace: null });
  }

  async loadInfra() {
    const res = await this.get('/infra', this.params());
    const top = (list: any[]) => list.slice(0, 8).map((s: any) => ({ name: s.pod, points: s.values as Point[] }));
    this.infra = { cpu: top(res.cpu || []), memory: top(res.memory || []), restarts: res.restarts || [], namespaces: res.namespaces || [] };
  }

  async loadProfiles() {
    const meta = await this.get('/profiles/meta', { since: this.since === '15m' || this.since === '1h' ? '24h' : this.since });
    this.profileMeta = { services: meta.services || [], profileTypes: meta.profileTypes || [] };
    if (!this.profileType) this.profileType = this.profileMeta.profileTypes[0] || '';
    if (!this.profileService && this.profileMeta.services.length) this.profileService = this.profileMeta.services[0];
    await this.loadFlame();
  }

  async loadFlame() {
    if (!this.profileService) { this.flame = { flamebearer: null, units: null }; return; }
    const res = await this.get('/query/pyroscope', this.params({ service: this.profileService, profileType: this.profileType }));
    this.flame = { flamebearer: res.flamebearer || null, units: res.metadata?.units || null };
  }

  async loadRum() {
    const seconds = SINCE_SECONDS[this.since] || 3600;
    const results = await Promise.all(this.vitals.map((v) => this.get('/query/loki', { query: webVitalQuery(v, seconds), since: this.since }).catch(() => null)));
    const pages = new Map<string, Record<string, number | null>>();
    results.forEach((res, i) => {
      for (const s of res?.result || []) {
        const page = String(s?.metric?.page_url || '(unknown page)');
        const vals = (s?.values || []).map((v: any) => Number(v[1])).filter((n: number) => Number.isFinite(n));
        const row = pages.get(page) || {};
        row[this.vitals[i]] = vals.length ? vals[vals.length - 1] : null;
        pages.set(page, row);
      }
    });
    this.rum = [...pages.entries()].map(([page, values]) => ({ page, values })).sort((a, b) => a.page.localeCompare(b.page)).slice(0, 100);
    this.rumLoaded = true;
  }

  fmtVital(v: string, value: number | null | undefined): string {
    if (value === null || value === undefined) return '—';
    return v === 'cls' ? value.toFixed(3) : fmtMs(value);
  }

  vitalClass(v: string, value: number | null | undefined): string {
    if (value === null || value === undefined) return '';
    const limits: Record<string, [number, number]> = { lcp: [2500, 4000], inp: [200, 500], cls: [0.1, 0.25], fcp: [1800, 3000], ttfb: [800, 1800] };
    const [good, poor] = limits[v] || [Infinity, Infinity];
    return value <= good ? 'obs-ok' : value <= poor ? 'obs-warn' : 'obs-bad';
  }

  traceStart(t: any): Date | null {
    return nsToDate(t?.startTime);
  }

  firstSpanName(t: any): string {
    return t?.spans?.[0]?.name || '';
  }
}
