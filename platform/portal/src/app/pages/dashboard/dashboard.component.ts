import { Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { AlertingApiService } from '../alerting/alerting-api.service';
import { averageDeployTime } from './dashboard-stats';
import {
  ActivityItem, AppRow, AttentionItem, ChecklistItem,
  buildActivity, buildApps, buildAttention, buildChecklist, timeAgo,
} from './dashboard-model';

const CHECKLIST_HIDDEN_KEY = 'platform.dashboard.setupHidden';

/**
 * Home page. Answers three questions in order: is anything wrong, how are my
 * apps, and what happened recently. Everything shown comes from the API; a
 * source that fails or that the user's role cannot read is simply left out.
 */
@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.css',
})
export class DashboardComponent implements OnInit, OnDestroy {
  loaded = false;
  greeting = 'Welcome';
  platformName = '';
  platformVersion = '';
  releasesUrl = '';

  projects: any[] = [];
  apps: AppRow[] = [];
  attention: AttentionItem[] = [];
  activity: ActivityItem[] = [];
  checklist: ChecklistItem[] = [];
  checklistHidden = false;
  avgDeployTime = '—';

  /** Server and backup summary (DevOps and admins only). */
  canSeePlatform = false;
  k8sConnected: boolean | null = null;
  nodes: { name: string; status: string; role?: string }[] = [];
  backup: { success: boolean; finishedAt: string } | null = null;
  backupKnown = false;

  readonly timeAgo = timeAgo;
  private timer?: ReturnType<typeof setInterval>;

  constructor(private api: ApiService, private auth: AuthService, private alerting: AlertingApiService) {}

  get readyNodes(): number { return this.nodes.filter((n) => n.status === 'Ready').length; }
  get checklistDone(): number { return this.checklist.filter((c) => c.done).length; }
  get showChecklist(): boolean {
    return !this.checklistHidden && this.checklist.length > 0 && this.checklistDone < this.checklist.length;
  }

  async ngOnInit() {
    const user = this.auth.getUser() || {};
    const first = String(user.name || '').trim().split(/\s+/)[0];
    const h = new Date().getHours();
    const part = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    this.greeting = first ? `${part}, ${first}` : part;
    this.canSeePlatform = this.auth.isDevOps() || this.auth.isAdmin();
    try { this.checklistHidden = localStorage.getItem(CHECKLIST_HIDDEN_KEY) === '1'; } catch { /* storage unavailable */ }

    await this.load();
    // Keep the status line current without a full reload.
    this.timer = setInterval(() => this.load(), 30_000);
  }

  ngOnDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async load() {
    const settle = <T>(p: Promise<T>) => p.then((v) => v, () => null);
    const platform = this.canSeePlatform;
    const [projects, incidents, status, version, nodes, backups, me, users] = await Promise.all([
      settle(firstValueFrom(this.api.getProjects())),
      settle(firstValueFrom(this.alerting.allIncidents('open'))),
      settle(firstValueFrom(this.api.getBootstrapStatus())),
      settle(firstValueFrom(this.api.getPlatformVersion())),
      platform ? settle(firstValueFrom(this.api.getNodes())) : Promise.resolve(null),
      platform ? settle(firstValueFrom(this.api.getBackupStatus())) : Promise.resolve(null),
      settle(firstValueFrom(this.api.getMe())),
      this.auth.canManageUsers() ? settle(firstValueFrom(this.api.getUsers())) : Promise.resolve(null),
    ]) as any[];

    this.projects = Array.isArray(projects) ? projects : [];
    const openIncidents = Array.isArray(incidents) ? incidents : [];
    this.platformName = status?.platformName || '';
    this.platformVersion = version?.imageTag || version?.platformVersion || version?.version || '';
    this.releasesUrl = version?.releases || '';

    if (nodes && typeof nodes === 'object') {
      this.k8sConnected = nodes.k8sConnected ?? null;
      // When the cluster is unreachable the list is not real; don't show it.
      this.nodes = nodes.k8sConnected ? (nodes.nodes || []) : [];
    }
    const backupItems = Array.isArray(backups?.items) ? backups.items : null;
    this.backupKnown = !!backupItems;
    this.backup = backupItems?.find((b: any) => b.operation === 'backup')?.status ?? null;

    this.apps = buildApps(this.projects);
    const deployments = this.projects.flatMap((p) => p.deployments || []);
    this.avgDeployTime = averageDeployTime(deployments);
    this.activity = buildActivity(this.projects, openIncidents);
    const update = version?.updateAvailable && version?.latestRelease?.tag
      ? { tag: version.latestRelease.tag, url: this.releasesUrl || version.latestRelease.url || '' }
      : null;
    this.attention = buildAttention({
      apps: this.apps,
      incidents: openIncidents,
      backups: backupItems,
      k8sConnected: platform ? this.k8sConnected : null,
      nodes: this.nodes,
      update: update && update.url ? update : null,
    });
    this.checklist = buildChecklist({
      projects: this.projects,
      mfaEnabled: typeof me?.mfaEnabled === 'boolean' ? me.mfaEnabled : undefined,
      userCount: Array.isArray(users) ? users.length : null,
      backupOk: backupItems ? !!this.backup?.success : null,
    });
    this.loaded = true;
  }

  hideChecklist() {
    this.checklistHidden = true;
    try { localStorage.setItem(CHECKLIST_HIDDEN_KEY, '1'); } catch { /* storage unavailable */ }
  }

  toneClass(t: string): string {
    return t === 'ok' ? 'status-ok' : t === 'warn' ? 'status-warn' : t === 'down' ? 'status-down' : '';
  }
}
