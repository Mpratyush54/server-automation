import { ChangeDetectorRef, Component, OnDestroy, OnInit, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

export type CheckType = 'http' | 'multistep' | 'browser' | 'ssl';

export interface SyntheticCheckView {
  id: string;
  name: string;
  type: CheckType;
  enabled: boolean;
  intervalSeconds: number;
  timeoutMs: number;
  environmentId: string | null;
  config: any;
  alertPolicy: { enabled: boolean; failureThreshold: number; severity: 'warning' | 'critical' };
  secretNames: string[];
  lastStatus: 'up' | 'down' | 'degraded' | 'unknown';
  lastRunAt: string | null;
  lastLatencyMs: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  alertState: 'ok' | 'warning' | 'firing';
  sslExpiresAt: string | null;
}

export interface SyntheticResultView {
  id: string;
  status: 'pass' | 'fail' | 'degraded';
  latencyMs: number | null;
  statusCode: number | null;
  error: string | null;
  assertions: Array<{ source: string; property?: string; comparison: string; target?: unknown; actual: string | null; passed: boolean; message?: string }> | null;
  steps: Array<{ name: string; status: string; latencyMs: number | null; statusCode?: number | null; error?: string }> | null;
  sslExpiresAt: string | null;
  hasScreenshot: boolean;
  startedAt: string;
}

interface Draft {
  id: string | null;
  name: string;
  type: CheckType;
  enabled: boolean;
  intervalSeconds: number;
  timeoutMs: number;
  configText: string;
  alertEnabled: boolean;
  failureThreshold: number;
  severity: 'warning' | 'critical';
  secretNames: string[];
  newSecrets: Array<{ name: string; value: string }>;
  removedSecrets: string[];
}

/** Starter config per type when the editor switches type. */
export const DEFAULT_CONFIGS: Record<CheckType, any> = {
  http: { url: 'https://example.com/', method: 'GET', assertions: [{ source: 'status', comparison: 'lt', target: 400 }] },
  multistep: { steps: [{ name: 'Step 1', method: 'GET', url: 'https://example.com/api', assertions: [], extract: [] }] },
  ssl: { host: 'example.com', port: 443, warnDays: 14, criticalDays: 0 },
  browser: { steps: [{ action: 'goto', url: 'https://example.com/' }, { action: 'wait_for', selector: 'h1' }] },
};

/** Build the API body from the editor state (pure; unit-tested). */
export function draftToBody(d: Draft): any {
  let config: any;
  try {
    config = JSON.parse(d.configText);
  } catch {
    throw new Error('Config is not valid JSON');
  }
  const secrets: Record<string, string | null> = {};
  for (const s of d.newSecrets) if (s.name.trim() && s.value) secrets[s.name.trim()] = s.value;
  for (const n of d.removedSecrets) secrets[n] = null;
  return {
    name: d.name.trim(),
    type: d.type,
    enabled: d.enabled,
    intervalSeconds: Number(d.intervalSeconds),
    timeoutMs: Number(d.timeoutMs),
    config,
    alertPolicy: { enabled: d.alertEnabled, failureThreshold: Number(d.failureThreshold), severity: d.severity },
    ...(Object.keys(secrets).length ? { secrets } : {}),
  };
}

/** Bars for the results timeline: oldest left, newest right. */
export function timelineBars(results: SyntheticResultView[], max = 60): Array<{ id: string; status: string; height: number; title: string }> {
  const slice = results.slice(0, max).reverse();
  const peak = Math.max(1, ...slice.map((r) => r.latencyMs || 0));
  return slice.map((r) => ({
    id: r.id,
    status: r.status,
    height: r.latencyMs ? Math.max(8, Math.round((r.latencyMs / peak) * 100)) : 100,
    title: `${new Date(r.startedAt).toLocaleString()} · ${r.status}${r.latencyMs !== null ? ` · ${r.latencyMs} ms` : ''}`,
  }));
}

/**
 * Synthetic monitoring for one project (#42): checks list, editor with templates and
 * write-only secrets, results timeline with assertion/step details and failure screenshots.
 * Route: /projects/:id/synthetics
 */
@Component({
  selector: 'app-synthetics',
  standalone: true,
  imports: [FormsModule, RouterLink],
  templateUrl: './synthetics.component.html',
  styleUrl: './synthetics.component.css',
})
export class SyntheticsComponent implements OnInit, OnDestroy {
  private http = inject(HttpClient);
  private route = inject(ActivatedRoute);
  private cdr = inject(ChangeDetectorRef);

  projectId = '';
  checks: SyntheticCheckView[] = [];
  capabilities: any = null;
  templates: any[] = [];
  loading = false;
  error = '';
  notice = '';

  selected: SyntheticCheckView | null = null;
  results: SyntheticResultView[] = [];
  bars: ReturnType<typeof timelineBars> = [];
  detail: SyntheticResultView | null = null;
  screenshotUrl: string | null = null;

  draft: Draft | null = null;
  saving = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  readonly types: CheckType[] = ['http', 'multistep', 'ssl', 'browser'];
  readonly varSyntax = '{{name}}';
  readonly secretSyntax = '{{secret.NAME}}';

  async ngOnInit() {
    this.projectId = this.route.snapshot.paramMap.get('id') || '';
    await this.load();
    const checkId = this.route.snapshot.queryParamMap?.get('check');
    const pre = checkId ? this.checks.find((c) => c.id === checkId) : null;
    if (pre) await this.select(pre);
    this.timer = setInterval(() => { if (document.visibilityState === 'visible' && !this.draft) void this.refresh(); }, 30_000);
  }

  ngOnDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.clearScreenshot();
  }

  private base() { return `/api/projects/${this.projectId}/synthetics`; }

  async load() {
    this.loading = true;
    this.error = '';
    try {
      const [list, caps, tpl] = await Promise.all([
        firstValueFrom(this.http.get<{ checks: SyntheticCheckView[] }>(`${this.base()}/checks`)),
        firstValueFrom(this.http.get<any>('/api/synthetics/capabilities')).catch(() => null),
        firstValueFrom(this.http.get<{ templates: any[] }>('/api/synthetics/templates')).catch(() => ({ templates: [] })),
      ]);
      this.checks = list.checks;
      this.capabilities = caps;
      this.templates = tpl.templates;
    } catch (err: any) {
      this.error = err?.error?.error || 'Failed to load checks';
    }
    this.loading = false;
    this.cdr.markForCheck();
  }

  async refresh() {
    try {
      const list = await firstValueFrom(this.http.get<{ checks: SyntheticCheckView[] }>(`${this.base()}/checks`));
      this.checks = list.checks;
      if (this.selected) {
        this.selected = this.checks.find((c) => c.id === this.selected!.id) || null;
        if (this.selected) await this.loadResults();
      }
      this.cdr.markForCheck();
    } catch { /* keep the last view */ }
  }

  async select(c: SyntheticCheckView) {
    this.selected = c;
    this.detail = null;
    this.clearScreenshot();
    await this.loadResults();
  }

  async loadResults() {
    if (!this.selected) return;
    try {
      const r = await firstValueFrom(this.http.get<{ results: SyntheticResultView[] }>(`${this.base()}/checks/${this.selected.id}/results`, { params: { limit: 100 } }));
      this.results = r.results;
      this.bars = timelineBars(this.results);
    } catch {
      this.results = [];
      this.bars = [];
    }
    this.cdr.markForCheck();
  }

  async showResult(id: string) {
    this.detail = this.results.find((r) => r.id === id) || null;
    this.clearScreenshot();
    if (this.detail?.hasScreenshot) {
      try {
        const blob = await firstValueFrom(this.http.get(`${this.base()}/results/${id}/screenshot`, { responseType: 'blob' }));
        this.screenshotUrl = URL.createObjectURL(blob);
      } catch { this.screenshotUrl = null; }
    }
    this.cdr.markForCheck();
  }

  private clearScreenshot() {
    if (this.screenshotUrl) URL.revokeObjectURL(this.screenshotUrl);
    this.screenshotUrl = null;
  }

  newCheck(template?: any) {
    const t = template?.check || { type: 'http', intervalSeconds: 300, timeoutMs: 10000, config: DEFAULT_CONFIGS.http };
    this.draft = {
      id: null, name: template?.name || '', type: t.type, enabled: true,
      intervalSeconds: t.intervalSeconds, timeoutMs: t.timeoutMs,
      configText: JSON.stringify(t.config, null, 2),
      alertEnabled: true, failureThreshold: 2, severity: 'critical',
      secretNames: [], newSecrets: [], removedSecrets: [],
    };
    this.notice = '';
  }

  editCheck(c: SyntheticCheckView) {
    const { statusPage, ...rest } = c.config || {};
    this.draft = {
      id: c.id, name: c.name, type: c.type, enabled: c.enabled,
      intervalSeconds: c.intervalSeconds, timeoutMs: c.timeoutMs,
      configText: JSON.stringify({ ...rest, ...(statusPage ? { statusPage } : {}) }, null, 2),
      alertEnabled: c.alertPolicy?.enabled !== false, failureThreshold: c.alertPolicy?.failureThreshold || 2,
      severity: c.alertPolicy?.severity || 'critical',
      secretNames: [...(c.secretNames || [])], newSecrets: [], removedSecrets: [],
    };
    this.notice = '';
  }

  changeType(type: CheckType) {
    if (!this.draft || this.draft.id) return;
    this.draft.type = type;
    this.draft.configText = JSON.stringify(DEFAULT_CONFIGS[type], null, 2);
    const min = this.capabilities?.minIntervalSeconds?.[type] || 60;
    if (this.draft.intervalSeconds < min) this.draft.intervalSeconds = min === 60 ? 300 : min;
    if (type === 'browser' && this.draft.timeoutMs < 30000) this.draft.timeoutMs = 60000;
  }

  addSecret() { this.draft?.newSecrets.push({ name: '', value: '' }); }
  removeNewSecret(i: number) { this.draft?.newSecrets.splice(i, 1); }
  toggleRemoveSecret(name: string) {
    if (!this.draft) return;
    const i = this.draft.removedSecrets.indexOf(name);
    if (i >= 0) this.draft.removedSecrets.splice(i, 1);
    else this.draft.removedSecrets.push(name);
  }

  cancel() { this.draft = null; this.error = ''; }

  async save() {
    if (!this.draft) return;
    this.error = '';
    let body: any;
    try {
      body = draftToBody(this.draft);
    } catch (err: any) {
      this.error = err.message;
      return;
    }
    this.saving = true;
    try {
      const res: any = this.draft.id
        ? await firstValueFrom(this.http.put(`${this.base()}/checks/${this.draft.id}`, body))
        : await firstValueFrom(this.http.post(`${this.base()}/checks`, body));
      this.draft = null;
      this.notice = res?.resources?.error ? `Saved; Kubernetes sync will be retried (${res.resources.error})` : 'Saved';
      await this.load();
      const saved = this.checks.find((c) => c.id === res?.check?.id);
      if (saved) await this.select(saved);
    } catch (err: any) {
      this.error = err?.error?.error || 'Save failed';
    }
    this.saving = false;
    this.cdr.markForCheck();
  }

  async remove(c: SyntheticCheckView) {
    if (!confirm(`Delete check "${c.name}" and its history?`)) return;
    try {
      await firstValueFrom(this.http.delete(`${this.base()}/checks/${c.id}`));
      if (this.selected?.id === c.id) { this.selected = null; this.results = []; this.bars = []; }
      await this.load();
    } catch (err: any) {
      this.error = err?.error?.error || 'Delete failed';
    }
  }

  async runNow(c: SyntheticCheckView) {
    this.error = '';
    try {
      const r: any = await firstValueFrom(this.http.post(`${this.base()}/checks/${c.id}/run`, {}));
      this.notice = `Run finished: ${r?.result?.status}`;
      await this.refresh();
      if (this.selected?.id !== c.id) await this.select(this.checks.find((x) => x.id === c.id) || c);
    } catch (err: any) {
      this.error = err?.error?.error || 'Run failed';
    }
    this.cdr.markForCheck();
  }

  statusClass(s: string): string {
    if (s === 'up' || s === 'pass') return 'st-ok';
    if (s === 'degraded') return 'st-warn';
    if (s === 'down' || s === 'fail') return 'st-bad';
    return 'st-unknown';
  }

  target(c: SyntheticCheckView): string {
    if (c.type === 'ssl') return `${c.config?.host}:${c.config?.port || 443}`;
    if (c.type === 'http') return c.config?.url || '';
    const steps = c.config?.steps || [];
    return `${steps.length} step${steps.length === 1 ? '' : 's'}`;
  }

  interval(s: number): string {
    return s % 3600 === 0 ? `${s / 3600} h` : s % 60 === 0 ? `${s / 60} min` : `${s} s`;
  }
}
