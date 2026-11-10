import { Component, OnInit } from '@angular/core';
import { DatePipe, DecimalPipe, JsonPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../services/api.service';
import { AlertingApiService } from './alerting-api.service';

type Tab = 'incidents' | 'monitors' | 'slos' | 'silences' | 'channels' | 'oncall';

/** Secret / config fields shown per channel type when creating a channel. */
const CHANNEL_FIELDS: Record<string, { key: string; label: string; secret: boolean; placeholder?: string }[]> = {
  slack: [
    { key: 'webhookUrl', label: 'Incoming webhook URL', secret: true, placeholder: 'https://hooks.slack.com/services/...' },
    { key: 'botToken', label: 'or Bot token (app)', secret: true, placeholder: 'xoxb-...' },
    { key: 'channel', label: 'Channel (app only)', secret: false, placeholder: '#alerts' },
  ],
  pagerduty: [{ key: 'routingKey', label: 'Events v2 integration key', secret: true }, { key: 'region', label: 'Region (us / eu)', secret: false, placeholder: 'us' }],
  teams: [{ key: 'webhookUrl', label: 'Workflows webhook URL', secret: true }],
  discord: [{ key: 'webhookUrl', label: 'Webhook URL', secret: true }],
  webhook: [{ key: 'url', label: 'URL', secret: true }, { key: 'signingSecret', label: 'Signing secret (blank = generate)', secret: true }],
  email: [{ key: 'to', label: 'Recipients (comma separated)', secret: false }],
};

/**
 * Alerting and on-call (#43): incidents, monitors, SLO dashboard (error budget remaining),
 * silences / maintenance windows, notification channels, escalation policies and schedules.
 */
@Component({
  selector: 'app-alerting',
  standalone: true,
  imports: [FormsModule, DatePipe, DecimalPipe, JsonPipe],
  templateUrl: './alerting.component.html',
})
export class AlertingComponent implements OnInit {
  readonly tabs: { id: Tab; label: string }[] = [
    { id: 'incidents', label: 'Incidents' },
    { id: 'monitors', label: 'Monitors' },
    { id: 'slos', label: 'SLOs' },
    { id: 'silences', label: 'Silences' },
    { id: 'channels', label: 'Channels' },
    { id: 'oncall', label: 'Escalation & on-call' },
  ];
  readonly channelFields = CHANNEL_FIELDS;
  readonly channelTypes = Object.keys(CHANNEL_FIELDS);

  tab: Tab = 'incidents';
  projects: any[] = [];
  projectId = '';
  mode = '';
  error = '';
  notice = '';
  loading = false;

  incidentFilter = 'open';
  incidents: any[] = [];
  monitors: any[] = [];
  slos: any[] = [];
  silences: any[] = [];
  channels: any[] = [];
  policies: any[] = [];
  schedules: any[] = [];

  newMonitor: any = this.blankMonitor();
  newSlo: any = this.blankSlo();
  newSilence: any = { kind: 'silence', durationMinutes: 60, matcherName: '', matcherValue: '', comment: '' };
  newChannel: any = { type: 'slack', name: '', minSeverity: 'info', fields: {} as Record<string, string> };
  newPolicy: any = { name: '', isDefault: true, step0: [] as string[], delay: 15, step1: [] as string[], step1Schedule: '' };
  newSchedule: any = { name: '', userIds: '', rotationHours: 168 };

  constructor(private api: ApiService, private alerting: AlertingApiService, private route: ActivatedRoute, private router: Router) {}

  async ngOnInit() {
    const q = this.route.snapshot.queryParamMap;
    this.projectId = q.get('projectId') || '';
    const tab = q.get('tab') as Tab | null;
    if (tab && this.tabs.some((t) => t.id === tab)) this.tab = tab;
    try { this.projects = await firstValueFrom(this.api.getProjects()); } catch { this.projects = []; }
    try { this.mode = (await firstValueFrom(this.alerting.status())).mode; } catch { this.mode = ''; }
    await this.reload();
  }

  blankMonitor() {
    return { name: '', kind: 'metric', query: '', signal: 'error_rate', service: '', resource: 'cpu', operator: '>', threshold: 0, forSeconds: 300, severity: 'warning', policyId: '' };
  }

  blankSlo() {
    return { name: '', sliType: 'availability', service: '', latencyMs: 256, errorQuery: '', totalQuery: '', target: 99.9, windowDays: 30, policyId: '' };
  }

  projectName(id: string): string {
    return this.projects.find((p) => p.id === id)?.name || id;
  }

  selectTab(t: Tab) {
    this.tab = t;
    this.router.navigate([], { queryParams: { projectId: this.projectId || null, tab: t }, replaceUrl: true });
    void this.reload();
  }

  async selectProject() {
    this.router.navigate([], { queryParams: { projectId: this.projectId || null, tab: this.tab }, replaceUrl: true });
    await this.reload();
  }

  private fail(err: any) {
    this.error = err?.error?.error || err?.message || 'Request failed';
  }

  async reload() {
    this.error = '';
    this.loading = true;
    try {
      if (this.tab === 'incidents') {
        this.incidents = this.projectId
          ? await firstValueFrom(this.alerting.list(this.projectId, 'incidents', { status: this.incidentFilter }))
          : await firstValueFrom(this.alerting.allIncidents(this.incidentFilter));
      } else if (this.projectId) {
        if (this.tab === 'monitors') this.monitors = await firstValueFrom(this.alerting.list(this.projectId, 'monitors'));
        if (this.tab === 'slos') this.slos = await firstValueFrom(this.alerting.list(this.projectId, 'slos'));
        if (this.tab === 'silences') this.silences = await firstValueFrom(this.alerting.list(this.projectId, 'silences'));
        if (this.tab === 'channels' || this.tab === 'oncall') this.channels = await firstValueFrom(this.alerting.list(this.projectId, 'channels'));
        if (this.tab === 'oncall' || this.tab === 'monitors' || this.tab === 'slos') this.policies = await firstValueFrom(this.alerting.list(this.projectId, 'policies'));
        if (this.tab === 'oncall') this.schedules = await firstValueFrom(this.alerting.list(this.projectId, 'schedules'));
      }
    } catch (err) {
      this.fail(err);
    }
    this.loading = false;
  }

  // Incidents
  async ack(i: any) {
    try { await firstValueFrom(this.alerting.ack(i.projectId, i.id)); await this.reload(); } catch (err) { this.fail(err); }
  }
  async resolveIncident(i: any) {
    try { await firstValueFrom(this.alerting.resolve(i.projectId, i.id)); await this.reload(); } catch (err) { this.fail(err); }
  }
  async testEvent(status: 'firing' | 'resolved') {
    if (!this.projectId) return;
    try {
      await firstValueFrom(this.alerting.testEvent(this.projectId, status));
      this.notice = status === 'firing' ? 'Test alert raised.' : 'Test alert resolved.';
      setTimeout(() => void this.reload(), 1500);
    } catch (err) { this.fail(err); }
  }

  // Monitors
  async createMonitor() {
    const m = this.newMonitor;
    const body: any = { name: m.name, kind: m.kind, operator: m.operator, threshold: Number(m.threshold), forSeconds: Number(m.forSeconds), severity: m.severity, policyId: m.policyId || null };
    if (m.kind === 'metric' || m.kind === 'log') body.query = m.query;
    if (m.kind === 'trace') body.params = { signal: m.signal, ...(m.service ? { service: m.service } : {}) };
    if (m.kind === 'resource') body.params = { resource: m.resource };
    try {
      await firstValueFrom(this.alerting.create(this.projectId, 'monitors', body));
      this.newMonitor = this.blankMonitor();
      await this.reload();
    } catch (err) { this.fail(err); }
  }
  async toggleMonitor(m: any) {
    try { await firstValueFrom(this.alerting.update(this.projectId, 'monitors', m.id, { enabled: !m.enabled })); await this.reload(); } catch (err) { this.fail(err); }
  }
  async deleteItem(what: 'monitors' | 'slos' | 'channels' | 'policies' | 'schedules', id: string) {
    if (!confirm('Delete this item?')) return;
    try { await firstValueFrom(this.alerting.remove(this.projectId, what, id)); await this.reload(); } catch (err) { this.fail(err); }
  }

  // SLOs
  budgetPercent(s: any): number | null {
    const v = s?.status?.errorBudgetRemaining;
    return typeof v === 'number' ? Math.max(-100, Math.min(100, v * 100)) : null;
  }
  async createSlo() {
    const s = this.newSlo;
    const body: any = { name: s.name, sliType: s.sliType, target: Number(s.target), windowDays: Number(s.windowDays), policyId: s.policyId || null, params: {} };
    if (s.service) body.params.service = s.service;
    if (s.sliType === 'latency') body.params.latencyMs = Number(s.latencyMs);
    if (s.sliType === 'ratio') { body.errorQuery = s.errorQuery; body.totalQuery = s.totalQuery; }
    try {
      await firstValueFrom(this.alerting.create(this.projectId, 'slos', body));
      this.newSlo = this.blankSlo();
      await this.reload();
    } catch (err) { this.fail(err); }
  }
  async refreshSlo(s: any) {
    try {
      const r = await firstValueFrom(this.alerting.sloStatus(this.projectId, s.id, true));
      s.status = r.status;
    } catch (err) { this.fail(err); }
  }

  // Silences
  async createSilence() {
    const s = this.newSilence;
    const matchers = s.matcherName ? [{ name: s.matcherName, value: s.matcherValue }] : [];
    try {
      await firstValueFrom(this.alerting.create(this.projectId, 'silences', { kind: s.kind, durationMinutes: Number(s.durationMinutes), matchers, comment: s.comment }));
      this.newSilence = { kind: 'silence', durationMinutes: 60, matcherName: '', matcherValue: '', comment: '' };
      await this.reload();
    } catch (err) { this.fail(err); }
  }
  async expireSilence(id: string) {
    try { await firstValueFrom(this.alerting.remove(this.projectId, 'silences', id)); await this.reload(); } catch (err) { this.fail(err); }
  }

  // Channels
  async createChannel() {
    const c = this.newChannel;
    const secrets: Record<string, string> = {};
    const config: Record<string, string> = {};
    for (const f of CHANNEL_FIELDS[c.type] || []) {
      const v = (c.fields[f.key] || '').trim();
      if (!v) continue;
      (f.secret ? secrets : config)[f.key] = v;
    }
    try {
      const res = await firstValueFrom(this.alerting.create(this.projectId, 'channels', { name: c.name, type: c.type, minSeverity: c.minSeverity, secrets, config }));
      this.notice = res.signingSecret ? `Channel created. Signing secret (shown once): ${res.signingSecret}` : 'Channel created.';
      this.newChannel = { type: c.type, name: '', minSeverity: 'info', fields: {} };
      await this.reload();
    } catch (err) { this.fail(err); }
  }
  async testChannel(c: any) {
    try {
      await firstValueFrom(this.alerting.testChannel(this.projectId, c.id));
      this.notice = `Test sent to ${c.name}.`;
    } catch (err) { this.fail(err); }
  }

  // Escalation + schedules
  channelName(id: string) { return this.channels.find((c) => c.id === id)?.name || id; }
  scheduleName(id: string) { return this.schedules.find((s) => s.id === id)?.name || id; }
  async createPolicy() {
    const p = this.newPolicy;
    const steps: any[] = [{ delayMinutes: 0, channelIds: p.step0 }];
    if (p.step1.length || p.step1Schedule) steps.push({ delayMinutes: Number(p.delay), channelIds: p.step1, scheduleIds: p.step1Schedule ? [p.step1Schedule] : [] });
    try {
      await firstValueFrom(this.alerting.create(this.projectId, 'policies', { name: p.name, isDefault: p.isDefault, steps }));
      this.newPolicy = { name: '', isDefault: true, step0: [], delay: 15, step1: [], step1Schedule: '' };
      await this.reload();
    } catch (err) { this.fail(err); }
  }
  async createSchedule() {
    const s = this.newSchedule;
    const userIds = String(s.userIds).split(',').map((x: string) => x.trim()).filter(Boolean);
    try {
      await firstValueFrom(this.alerting.create(this.projectId, 'schedules', { name: s.name, userIds, rotationHours: Number(s.rotationHours), startsAt: new Date().toISOString() }));
      this.newSchedule = { name: '', userIds: '', rotationHours: 168 };
      await this.reload();
    } catch (err) { this.fail(err); }
  }
  toggleIn(list: string[], id: string) {
    const i = list.indexOf(id);
    if (i >= 0) list.splice(i, 1); else list.push(id);
  }
}
