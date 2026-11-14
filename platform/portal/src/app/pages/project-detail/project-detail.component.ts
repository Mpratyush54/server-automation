import { DatabaseInsightsPanelComponent } from './database-insights-panel.component';
import { ReleasesPanelComponent } from './releases-panel.component';
import { AfterViewInit, Component, ElementRef, OnInit, OnDestroy, ViewChild, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { ArgocdPanelComponent } from './argocd-panel.component';
import { OperationProgressComponent } from '../../shared/operation-progress.component';
import { EnvironmentTabComponent } from './environment-tab/environment-tab.component';
import { TopologyGraphComponent } from './topology/topology-graph.component';
import { ProjectOverviewComponent } from './project-overview.component';
import { ProjectSettingsSectionComponent } from './project-settings-section.component';
import {
  PROJECT_SECTIONS, ProjectSection, StatusView, anchorForTab, currentDeployment, deploymentStatus,
  monitoringViewForTab, projectStatus, sectionForTab, statusClass,
} from './project-sections';
import { ObsProjectComponent } from '../observability/obs-project.component';
import { MONITORING_VIEWS, MonitoringView, VIEW_OBS_TABS, isMonitoringView } from '../observability/monitoring-views';
import { ErrorsComponent } from '../errors/errors.component';
import { ReplaysComponent } from '../replays/replays.component';
import { HeatmapsComponent } from '../heatmaps/heatmaps.component';
import { SyntheticsComponent } from '../synthetics/synthetics.component';
import { StatusPageEditorComponent } from '../status-page/status-page-editor.component';
import { ProjectAgentsComponent } from './project-agents.component';
import { ProjectUsageComponent } from './project-usage.component';
import { ToastService, DialogService, errorText } from '../../shared/feedback/feedback.service';

/** Query params that belong to a monitoring view; cleared when leaving it. */
const MONITORING_PARAMS = ['view', 'issue', 'check', 'trace', 'logTrace', 'service'] as const;

@Component({
  selector: 'app-project-detail',
  standalone: true,
  imports: [DatabaseInsightsPanelComponent, ReleasesPanelComponent, CommonModule, FormsModule, RouterModule, OperationProgressComponent, EnvironmentTabComponent, TopologyGraphComponent, ArgocdPanelComponent, ProjectOverviewComponent, ProjectSettingsSectionComponent,
    ObsProjectComponent, ErrorsComponent, ReplaysComponent, HeatmapsComponent, SyntheticsComponent, StatusPageEditorComponent, ProjectAgentsComponent, ProjectUsageComponent],
  templateUrl: './project-detail.component.html',
  styleUrls: ['./project-section-shared.css', './project-detail.component.css']
})
export class ProjectDetailComponent implements OnInit, OnDestroy, AfterViewInit {
  project: any;
  deployments: any[] = [];
  files: any[] = [];
  logs: any[] = [];
  metrics: any[] = [];
  aggregatedMetrics: any = { cpuAvg: 0, memoryAvg: 0, errorRate: 0 };
  storageAnalytics: any = { totalBytes: 0, count: 0, providerBreakdown: {} };
  dbConnections: any[] = [];

  /** Current section (#185); kept in `?tab=` so links and reloads land on it. */
  section: ProjectSection = 'overview';
  readonly sections = PROJECT_SECTIONS;
  readonly statusClass = statusClass;
  /** True once the first fetch finished (distinguishes "loading" from "not found"). */
  loaded = false;
  readonly storageQuotaBytes = 1024 * 1024 * 1024;
  @ViewChild('tabBar') private tabBar?: ElementRef<HTMLElement>;
  private pendingAnchor: string | null = null;
  /** #48: full telemetry profile installed (traces, Loki logs, infra, profiles, RUM). */
  observabilityEnabled = false;
  /** The observability status call has answered (avoids flashing the "needs full profile" notice). */
  observabilityChecked = false;
  /** Monitoring section view; kept in `?view=` (the page owns `?tab=`). */
  monitoringView: MonitoringView = 'overview';
  readonly monitoringViews = MONITORING_VIEWS;
  readonly viewObsTabs = VIEW_OBS_TABS;
  /** Error issue to open in the Errors view (from the overview list or `?issue=`). */
  monitoringIssue = '';
  role = 'devops';

  // SDK Tokens
  tokens: any[] = [];
  newKeyName = '';
  /** `server`: backend SDKs (config, secrets, registration). `browser`: frontend SDKs (ingest only). */
  newKeyKind: 'server' | 'browser' = 'server';
  generatedKeyPlaintext = '';
  generatedKeyKind: 'server' | 'browser' = 'server';

  // GitOps / ArgoCD Pods
  pods: any[] = [];
  k8sConnected = false;
  argoStatus: any = null;

  // API Metrics
  apiMetrics: any[] = [];

  // Databases
  newDb = { dbType: 'postgres', poolSize: 10 };
  testingDbId = '';
  provisioningDb = false;
  provisionedCreds: any = null;

  // Backups
  dbBackups: any[] = [];
  backupDbName = '';
  backupInProgress = false;

  // Form DTOs — empty until loaded from project's GitHub/GitLab repo
  deployDto = { version: '', branch: '', environmentId: '', commitSha: '', imageTag: 'latest', gitPath: 'k8s' };
  deployInProgress = false;
  /** Operation id of the last deploy started here (GET /api/operations/:id progress). */
  deployOperationId: string | null = null;
  gitBranches: { name: string; sha: string }[] = [];
  gitCommits: { sha: string; message: string; author: string; date: string }[] = [];
  gitReleases: any[] = [];
  latestRelease: any = null;
  updateAvailable = false;
  currentDeployedVersion: string | null = null;
  gitLoading = false;
  gitError = '';
  gitMeta: { ownerRepo?: string; defaultBranch?: string; provider?: string } = {};
  projectSettings = { repositoryUrl: '', domain: '', gitRevision: '' };
  savingSettings = false;
  members: any[] = [];
  newMember = { email: '', role: 'developer' };
  memberBusy = false;
  memberError = '';
  canManageAccess = false;
  newFileCategoryRoute = { category: '', provider: 'local' };
  searchLogQuery = { level: '', search: '' };

  // Timer for logs & heartbeats refresh
  private refreshTimer?: any;

  private router = inject(Router);

  private toast = inject(ToastService);
  private dialog = inject(DialogService);

  constructor(private route: ActivatedRoute, private api: ApiService, private auth: AuthService) {}

  /**
   * ?tab= deep link. Pre-#185 tab names (and the #29 config/secrets aliases) map
   * onto the new sections; the URL is rewritten to the canonical section id and
   * the page scrolls to the panel the old tab pointed at.
   */
  private applyTabParam() {
    const qp = this.route.snapshot?.queryParamMap;
    const tab = qp?.get('tab');
    if (!tab) return;
    this.section = sectionForTab(tab);
    this.pendingAnchor = anchorForTab(tab);
    const view = qp?.get('view');
    const legacyView = monitoringViewForTab(tab);
    if (isMonitoringView(view)) this.monitoringView = view;
    else if (legacyView && isMonitoringView(legacyView)) this.monitoringView = legacyView;
    this.monitoringIssue = qp?.get('issue') || '';
    if (tab !== this.section) this.writeTabParam(this.section, legacyView ? { view: this.monitoringView } : {});
  }

  private writeTabParam(section: ProjectSection, extra: Record<string, string | null> = {}) {
    this.router.navigate([], { relativeTo: this.route, queryParams: { tab: section, ...extra }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  /** Switch the Monitoring view; `writeUrl` false when the URL was already written (embedded panel links). */
  switchMonitoringView(view: MonitoringView, writeUrl = true, extra: Record<string, string> = {}) {
    this.monitoringIssue = view === 'errors' ? extra['issue'] || '' : '';
    const changed = view !== this.monitoringView;
    this.monitoringView = view;
    if ((changed || Object.keys(extra).length) && writeUrl) {
      const cleared = Object.fromEntries(MONITORING_PARAMS.map((k) => [k, null]));
      this.router.navigate([], { relativeTo: this.route, queryParams: { ...cleared, view, ...extra }, queryParamsHandling: 'merge', replaceUrl: true });
    }
    void this.loadMonitoringData();
  }

  /** Overview "Recent errors": open one issue (or the whole list) in the Errors view. */
  openErrorIssue(id: string | null) {
    this.switchMonitoringView('errors', true, id ? { issue: id } : {});
  }

  /** SDK data the current Monitoring view shows (heartbeats always; API latency and logs without full telemetry). */
  loadMonitoringData(): Promise<unknown> {
    const v = this.monitoringView;
    const jobs: Promise<unknown>[] = [];
    if (v === 'resources') jobs.push(this.loadMetrics());
    if (v === 'traces' && !this.observabilityEnabled) jobs.push(this.loadApiMetrics());
    if (v === 'logs' && !this.observabilityEnabled) jobs.push(this.loadLogs());
    return Promise.all(jobs);
  }

  async ngOnInit() {
    this.role = (this.auth.getRole() || 'developer').toLowerCase();
    this.canManageAccess = this.role === 'admin' || this.role === 'devops' || this.auth.canManageUsers?.() === true;
    this.applyTabParam();
    this.api.getObservabilityStatus?.()?.subscribe({
      next: (s: any) => { this.observabilityEnabled = !!s?.enabled; this.observabilityChecked = true; },
      error: () => { this.observabilityChecked = true; },
    });

    await this.fetchData();
    if (this.section === 'monitoring') await this.loadMonitoringData();
    if (this.section === 'data') await this.loadBackups();
    this.refreshTimer = setInterval(() => this.pollData(), 5000);
  }

  ngOnDestroy() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.logPollInterval) clearInterval(this.logPollInterval);
  }

  async fetchData() {
    const id = this.route.snapshot.paramMap.get('id')!;
    try {
      this.project = await firstValueFrom(this.api.getProject(id));
      if (this.project?.environments?.length) {
        this.deployDto.environmentId = this.project.environments[0].id;
      }
      this.projectSettings = {
        repositoryUrl: this.project?.repositoryUrl || '',
        gitRevision: this.project?.gitRevision || '',
        domain: this.project?.domain || '',
      };
      await this.loadGitInfo();
    } catch { this.project = null; }

    await this.loadDeployments();
    await this.loadFiles();
    await this.loadLogs();
    await this.loadMetrics();
    await this.loadDbConnections();
    await this.loadTokens();
    await this.loadK8sPods();
    await this.loadArgoStatus();
    await this.loadMembers();
    this.loaded = true;
  }

  async loadMembers() {
    if (!this.project?.id) return;
    try {
      this.members = await firstValueFrom(this.api.getProjectMembers(this.project.id));
      const me = this.auth.getUser();
      const myMembership = this.members.find((m: any) => m.userId === me?.id || m.user?.email === me?.email);
      if (myMembership?.role === 'owner' || myMembership?.role === 'devops') {
        this.canManageAccess = true;
      }
    } catch {
      this.members = [];
    }
  }

  async grantMember() {
    if (!this.project?.id || !this.newMember.email) return;
    this.memberBusy = true;
    this.memberError = '';
    try {
      await firstValueFrom(this.api.addProjectMember(this.project.id, {
        email: this.newMember.email.trim(),
        role: this.newMember.role,
      }));
      this.newMember = { email: '', role: 'developer' };
      await this.loadMembers();
    } catch (err: any) {
      this.memberError = err.error?.error || err.message || 'Failed to grant access';
    } finally {
      this.memberBusy = false;
    }
  }

  async changeMemberRole(m: any, role: string) {
    if (!this.project?.id) return;
    try {
      await firstValueFrom(this.api.updateProjectMember(this.project.id, m.id, role));
      this.toast.ok('Role changed');
      await this.loadMembers();
    } catch (err: any) {
      this.toast.error('Role was not changed: ' + errorText(err));
      await this.loadMembers();
    }
  }

  async revokeMember(m: any) {
    if (!this.project?.id) return;
    const who = m.user?.email || m.userId;
    const ok = await this.dialog.confirm({
      title: `Remove ${who} from this project?`,
      message: 'They lose access to this project right away. You can add them again later.',
      confirmLabel: 'Remove access',
      danger: true,
    });
    if (!ok) return;
    try {
      await firstValueFrom(this.api.removeProjectMember(this.project.id, m.id));
      this.toast.ok(`Access removed for ${who}`);
      await this.loadMembers();
    } catch (err: any) {
      this.toast.error('Access was not removed: ' + errorText(err));
    }
  }

  async pollData() {
    const s = this.section;
    if (s === 'overview' || s === 'deployments' || this.hasInFlightDeploy()) {
      await this.loadDeployments();
    }
    if (s === 'monitoring') await this.loadMonitoringData();
    if (s === 'data') await this.loadBackups();
    if (s === 'deployments') {
      await this.loadK8sPods();
      await this.loadArgoStatus();
    }
  }

  hasInFlightDeploy(): boolean {
    return this.deployments.some((d) =>
      ['pending', 'building', 'deploying'].includes(String(d.status || '').toLowerCase())
    );
  }

  async saveProjectSettings() {
    if (!this.project) return;
    this.savingSettings = true;
    try {
      this.project = await firstValueFrom(this.api.updateProject(this.project.id, {
        repositoryUrl: this.projectSettings.repositoryUrl || null,
        gitRevision: this.projectSettings.gitRevision || null,
        domain: this.projectSettings.domain || null,
      }));
      this.projectSettings = {
        repositoryUrl: this.project?.repositoryUrl || '',
        gitRevision: this.project?.gitRevision || '',
        domain: this.project?.domain || '',
      };
      await this.loadGitInfo();
      this.toast.ok('Project settings saved');
    } catch (err: any) {
      this.toast.error('Project settings were not saved: ' + errorText(err));
    } finally {
      this.savingSettings = false;
    }
  }

  async loadGitInfo() {
    this.gitError = '';
    this.gitBranches = [];
    this.gitCommits = [];
    this.gitReleases = [];
    this.latestRelease = null;
    this.updateAvailable = false;
    this.currentDeployedVersion = null;
    this.gitMeta = {};
    // #155: only call /git/branches when the project actually has a saved repository URL.
    // Unsaved projectSettings.repositoryUrl must not trigger provider API traffic.
    const repositoryUrl = (this.project?.repositoryUrl || '').trim();
    if (!repositoryUrl) {
      this.deployDto.branch = '';
      this.deployDto.commitSha = '';
      this.deployDto.version = '';
      return;
    }
    this.gitLoading = true;
    try {
      const data = await firstValueFrom(this.api.getProjectGitBranches(this.project.id));
      this.gitBranches = data.branches || [];
      this.gitMeta = {
        ownerRepo: data.ownerRepo,
        defaultBranch: data.defaultBranch,
        provider: data.provider,
      };
      if (data.defaultBranch && data.defaultBranch !== 'HEAD') this.project.defaultBranch = data.defaultBranch;
      const preferred =
        this.project.gitRevision ||
        this.gitBranches.find((b) => b.name === data.defaultBranch)?.name ||
        this.gitBranches[0]?.name ||
        '';
      if (preferred && !this.gitBranches.some(b => b.name === preferred)) this.gitBranches.unshift({ name: preferred, sha: '' });
      this.deployDto.branch = preferred;
      if (preferred) {
        await this.onBranchChange(preferred);
      }
      if (!this.deployDto.version) {
        this.deployDto.version = this.shortSha(this.deployDto.commitSha) || '0.0.1';
      }

      try {
        const rel = await firstValueFrom(this.api.getProjectGitReleases(this.project.id));
        this.gitReleases = rel.releases || [];
        this.latestRelease = rel.latestRelease || null;
        this.updateAvailable = !!rel.updateAvailable;
        this.currentDeployedVersion = rel.currentVersion || rel.currentTag || null;
      } catch {
        this.gitReleases = [];
      }
    } catch (err: any) {
      this.gitError = err.error?.error || err.message || 'Failed to load branches from Git';
      if (!this.deployDto.branch) this.deployDto.branch = this.project?.gitRevision || this.project?.defaultBranch || 'HEAD';
    } finally {
      this.gitLoading = false;
    }
  }

  async onBranchChange(branch?: string) {
    const name = branch || this.deployDto.branch;
    if (!this.project || !name) return;
    const tip = this.gitBranches.find((b) => b.name === name);
    if (tip?.sha) {
      this.deployDto.commitSha = tip.sha;
      this.deployDto.version = this.shortSha(tip.sha);
      this.deployDto.imageTag = this.shortSha(tip.sha) || 'latest';
    }
    try {
      const data = await firstValueFrom(this.api.getProjectGitCommits(this.project.id, name, 15));
      this.gitCommits = data.commits || [];
      if (this.gitCommits.length) {
        this.deployDto.commitSha = this.gitCommits[0].sha;
        this.deployDto.version = this.shortSha(this.gitCommits[0].sha);
        this.deployDto.imageTag = this.shortSha(this.gitCommits[0].sha) || 'latest';
      }
    } catch {
      this.gitCommits = [];
    }
  }

  onCommitChange() {
    if (this.deployDto.commitSha) {
      this.deployDto.version = this.shortSha(this.deployDto.commitSha);
      this.deployDto.imageTag = this.shortSha(this.deployDto.commitSha) || 'latest';
    }
  }

  shortSha(sha?: string): string {
    if (!sha) return '';
    return sha.slice(0, 7);
  }

  /** One-click: select a GitHub release tag and deploy it. */
  async deployRelease(release: any) {
    if (!release?.tag) return;
    this.deployDto.branch = release.tag;
    this.deployDto.commitSha = release.sha || release.tag;
    this.deployDto.version = release.tag;
    this.deployDto.imageTag = release.tag;
    // Load commits for the tag if possible (non-blocking)
    try {
      await this.onBranchChange(release.tag);
      this.deployDto.version = release.tag;
      this.deployDto.imageTag = release.tag;
      if (release.sha) this.deployDto.commitSha = release.sha;
    } catch {}
    await this.deploy();
  }

  async loadDeployments() {
    if (!this.project) return;
    try {
      this.deployments = await firstValueFrom(this.api.getProjectDeployments(this.project.id));
    } catch { this.deployments = []; }
  }

  async loadFiles() {
    if (!this.project) return;
    try {
      this.files = await firstValueFrom(this.api.getProjectFiles(this.project.id));
      this.storageAnalytics = await firstValueFrom(this.api.getStorageAnalytics(this.project.id));
    } catch { this.files = []; }
  }

  async loadLogs() {
    if (!this.project) return;
    try {
      const res = await firstValueFrom(this.api.searchLogs({
        projectId: this.project.id,
        level: this.searchLogQuery.level,
        search: this.searchLogQuery.search,
        limit: 100
      }));
      this.logs = res.logs || [];
    } catch { this.logs = []; }
  }

  async loadMetrics() {
    if (!this.project) return;
    try {
      this.metrics = await firstValueFrom(this.api.getMetrics(this.project.id));
      this.aggregatedMetrics = await firstValueFrom(this.api.getAggregatedMetrics(this.project.id));
    } catch { this.metrics = []; }
  }

  async loadDbConnections() {
    if (!this.project) return;
    try {
      this.dbConnections = await firstValueFrom(this.api.getDbConnections(this.project.id));
    } catch { this.dbConnections = []; }
  }

  async deploy() {
    if (!this.project?.repositoryUrl && !this.projectSettings.repositoryUrl) {
      this.toast.warn('Add a Git repository URL under Configuration, Git and domain, then deploy.');
      return;
    }
    if (!this.project.repositoryUrl && this.projectSettings.repositoryUrl) {
      await this.saveProjectSettings();
    }
    const selectedEnv = this.project?.environments?.find((e: any) => e.id === this.deployDto.environmentId);
    if (this.role === 'developer' && selectedEnv?.name === 'production') {
      this.toast.warn('Developers cannot deploy to production. Ask a tech lead or DevOps to deploy it.');
      return;
    }
    this.deployInProgress = true;
    try {
      const payload = {
        projectId: this.project.id,
        environmentId: this.deployDto.environmentId,
        version: this.deployDto.version,
        branch: this.deployDto.branch || this.project?.gitRevision || this.project?.defaultBranch || 'HEAD',
        commitSha: this.deployDto.commitSha || undefined,
        imageTag: this.deployDto.imageTag || 'latest',
        gitPath: this.deployDto.gitPath || 'k8s',
        pullFromGit: true,
      };
      const started: any = await firstValueFrom(this.api.deploy(payload));
      this.deployOperationId = started?.operationId || null;
      await this.loadDeployments();
      this.section = 'deployments';
    } catch (err: any) {
      this.toast.error('Deployment did not start: ' + errorText(err));
    } finally {
      this.deployInProgress = false;
    }
  }

  async rollback(depId: string) {
    try {
      await firstValueFrom(this.api.rollback({ deploymentId: depId }));
      await this.loadDeployments();
    } catch (err: any) {
      this.toast.error('Rollback did not start: ' + errorText(err));
    }
  }

  async restartDeploy(depId: string) {
    try {
      await firstValueFrom(this.api.restartDeployment(depId));
      await this.loadDeployments();
      this.toast.ok('Restart started');
    } catch (err: any) {
      this.toast.error('Restart did not start: ' + errorText(err));
    }
  }

  async deleteFile(fileId: string) {
    const ok = await this.dialog.confirm({
      title: 'Delete this file?',
      message: 'The file is removed from storage. This cannot be undone.',
      confirmLabel: 'Delete file',
      danger: true,
    });
    if (!ok) return;
    try {
      await firstValueFrom(this.api.deleteFile(fileId));
      this.toast.ok('File deleted');
      await this.loadFiles();
    } catch (err: any) {
      this.toast.error('File was not deleted: ' + errorText(err));
    }
  }

  async loadTokens() {
    if (!this.project) return;
    try {
      this.tokens = await firstValueFrom(this.api.getProjectTokens(this.project.id));
    } catch { this.tokens = []; }
  }

  async createToken() {
    if (!this.project || !this.newKeyName.trim()) return;
    try {
      const res = await firstValueFrom(this.api.createProjectToken(this.project.id, this.newKeyName, this.newKeyKind));
      this.generatedKeyPlaintext = res.token;
      this.generatedKeyKind = res.kind === 'browser' ? 'browser' : 'server';
      this.newKeyName = '';
      this.newKeyKind = 'server';
      await this.loadTokens();
    } catch (err: any) {
      this.toast.error('SDK key was not created: ' + errorText(err));
    }
  }

  async revokeToken(tokenId: string) {
    if (!this.project) return;
    const ok = await this.dialog.confirm({
      title: 'Revoke this SDK key?',
      message: 'Apps using it stop sending data right away. This cannot be undone; create a new key to restore access.',
      confirmLabel: 'Revoke key',
      danger: true,
    });
    if (!ok) return;
    try {
      await firstValueFrom(this.api.deleteProjectToken(this.project.id, tokenId));
      this.toast.ok('SDK key revoked');
      await this.loadTokens();
    } catch (err: any) {
      this.toast.error('SDK key was not revoked: ' + errorText(err));
    }
  }

  clearGeneratedToken() {
    this.generatedKeyPlaintext = '';
  }

  // GitOps / ArgoCD Pods Methods
  async loadK8sPods() {
    if (!this.project) return;
    try {
      const res = await firstValueFrom(this.api.getPods());
      this.k8sConnected = res.k8sConnected;
      const allPods = res.k8sConnected ? res.pods || [] : [];
      const projNameLower = this.project.name.toLowerCase();
      this.pods = allPods.filter((pod: any) => 
        pod.name.toLowerCase().includes(projNameLower) || 
        pod.namespace.toLowerCase().includes(projNameLower) ||
        (pod.namespace === 'preview' && pod.name.toLowerCase().includes(projNameLower))
      );
    } catch {
      this.pods = [];
      this.k8sConnected = false;
    }
  }

  async loadArgoStatus() {
    if (!this.project) return;
    try {
      this.argoStatus = await firstValueFrom(this.api.getArgoCDStatus(this.project.id));
    } catch {
      this.argoStatus = {
        connected: false,
        syncStatus: 'Offline',
        healthStatus: 'Unknown'
      };
    }
  }

  async loadApiMetrics() {
    if (!this.project) return;
    try {
      const res = await firstValueFrom(this.api.getApiMetrics(this.project.id));
      this.apiMetrics = res.metrics || [];
    } catch {
      this.apiMetrics = [];
    }
  }

  getSlowestEndpoint(): number {
    if (!this.apiMetrics.length) return 0;
    return Math.max(...this.apiMetrics.map((m: any) => m.p95 || 0));
  }

  getHighestErrorRate(): string {
    if (!this.apiMetrics.length) return '0.0';
    const highest = Math.max(...this.apiMetrics.map((m: any) => {
      const total = m.count || 1;
      return ((m.errors4xx + m.errors5xx) / total) * 100;
    }));
    return highest.toFixed(1);
  }

  // Pod log streamer terminal on project detail
  showLogsModal = false;
  selectedPodName = '';
  selectedPodNamespace = '';
  podLogsText = '';
  loadingLogs = false;
  private logPollInterval?: any;

  async openPodLogs(pod: any) {
    this.selectedPodName = pod.name;
    this.selectedPodNamespace = pod.namespace;
    this.showLogsModal = true;
    this.podLogsText = 'Connecting to pod container logs...';
    await this.fetchPodLogs();

    if (this.logPollInterval) clearInterval(this.logPollInterval);
    this.logPollInterval = setInterval(() => this.fetchPodLogs(), 3000);
  }

  async fetchPodLogs() {
    this.loadingLogs = true;
    try {
      const res = await firstValueFrom(this.api.getPodLogs(this.selectedPodNamespace, this.selectedPodName));
      this.podLogsText = res.logs || 'No log output returned from container.';
    } catch (err: any) {
      this.podLogsText = `Error fetching logs: ${err.message}`;
    } finally {
      this.loadingLogs = false;
    }
  }

  closeLogsModal() {
    this.showLogsModal = false;
    if (this.logPollInterval) {
      clearInterval(this.logPollInterval);
      this.logPollInterval = undefined;
    }
  }

  async restartPod(pod: any) {
    const ok = await this.dialog.confirm({
      title: `Restart pod ${pod.name}?`,
      message: `The pod is deleted in namespace ${pod.namespace} and its controller starts a new one. Requests to it fail until the new pod is ready.`,
      confirmLabel: 'Restart pod',
      danger: true,
    });
    if (!ok) return;
    try {
      await firstValueFrom(this.api.deletePod(pod.namespace, pod.name));
      this.toast.ok('Pod restarted. Its controller is starting a new one.');
      await this.loadK8sPods();
    } catch (err: any) {
      this.toast.error('Pod was not restarted: ' + errorText(err));
    }
  }

  // Databases Methods
  async provisionDb(environment: string) {
    if (!this.project) return;
    const ok = await this.dialog.confirm({
      title: `Create a PostgreSQL database for ${environment}?`,
      message: `Cairn creates a new, isolated database for ${this.project.name} in ${environment} and shows its credentials once.`,
      confirmLabel: 'Create database',
    });
    if (!ok) return;
    this.provisioningDb = true;
    this.provisionedCreds = null;
    try {
      const res = await firstValueFrom(this.api.provisionDatabase(this.project.id, environment));
      this.provisionedCreds = res;
      await this.loadDbConnections();
    } catch (err: any) {
      this.toast.error('Database was not created: ' + errorText(err));
    } finally {
      this.provisioningDb = false;
    }
  }

  dismissProvisionedCreds() {
    this.provisionedCreds = null;
  }

  async loadBackups() {
    if (!this.project) return;
    try {
      this.dbBackups = await firstValueFrom(this.api.getDbBackups(this.project.id, ''));
    } catch {
      this.dbBackups = [];
    }
  }

  async triggerBackup() {
    if (!this.project || !this.backupDbName.trim()) {
      this.toast.warn('Enter the name of the database to back up.');
      return;
    }
    const ok = await this.dialog.confirm({
      title: `Back up ${this.backupDbName}?`,
      message: 'The backup runs in the background and can take a while for large databases. The app keeps running.',
      confirmLabel: 'Start backup',
    });
    if (!ok) return;
    this.backupInProgress = true;
    try {
      await firstValueFrom(this.api.triggerBackup(this.project.id, this.backupDbName));
      this.toast.ok('Backup started. It appears in the list when it finishes.');
      setTimeout(() => this.loadBackups(), 3000);
    } catch (err: any) {
      this.toast.error('Backup did not start: ' + errorText(err));
    } finally {
      this.backupInProgress = false;
    }
  }

  async restoreBackup(backup: any) {
    if (!this.project) return;
    const ok = await this.dialog.confirm({
      title: `Restore ${backup.dbName} from this backup?`,
      message: `The current contents of ${backup.dbName} are replaced with the backup from ${new Date(backup.createdAt).toLocaleString()}. Changes made since then are lost.`,
      confirmLabel: 'Restore backup',
      danger: true,
    });
    if (!ok) return;
    try {
      await firstValueFrom(this.api.restoreBackup(this.project.id, 'db', backup.id));
      this.toast.ok('Restore started');
      setTimeout(() => this.loadBackups(), 3000);
    } catch (err: any) {
      this.toast.error('Restore did not start: ' + errorText(err));
    }
  }

  async addDbConnection() {
    if (!this.project) return;
    try {
      const payload = {
        projectId: this.project.id,
        dbType: this.newDb.dbType,
        poolSize: this.newDb.poolSize
      };
      await firstValueFrom(this.api.createDbConnection(payload));
      await this.loadDbConnections();
      this.toast.ok('Database connection added');
    } catch (err: any) {
      this.toast.error('Database connection was not added: ' + errorText(err));
    }
  }

  async testDbConnection(id: string) {
    this.testingDbId = id;
    try {
      const res = await firstValueFrom(this.api.testDbConnection(id));
      this.toast.ok(`Connection works: ${res.status}, ${res.latencyMs} ms`);
      await this.loadDbConnections();
    } catch (err: any) {
      this.toast.error('Connection test failed: ' + errorText(err));
    } finally {
      this.testingDbId = '';
    }
  }

  async deleteDbConnection(id: string) {
    const ok = await this.dialog.confirm({
      title: 'Disconnect this database?',
      message: 'The saved connection is removed from this project. The database and its data are not deleted.',
      confirmLabel: 'Disconnect database',
      danger: true,
    });
    if (!ok) return;
    try {
      await firstValueFrom(this.api.deleteDbConnection(id));
      this.toast.ok('Database disconnected');
      await this.loadDbConnections();
    } catch (err: any) {
      this.toast.error('Database was not disconnected: ' + errorText(err));
    }
  }

  ngAfterViewInit() {
    this.scrollActiveTabIntoView();
    if (this.pendingAnchor) {
      const anchor = this.pendingAnchor;
      this.pendingAnchor = null;
      this.scrollToAnchor(anchor);
    }
  }

  get projectStatusView(): StatusView {
    return projectStatus(this.project);
  }

  depStatus(status: string): StatusView {
    return deploymentStatus(status);
  }

  /** Newest live deployment for an environment (else the newest attempt). */
  envCurrent(environmentId: string): any | null {
    return currentDeployment(this.deployments, environmentId);
  }

  get appUrl(): string | null {
    const d = String(this.project?.domain || '').trim();
    if (!d) return null;
    return /^https?:\/\//.test(d) ? d : `https://${d}`;
  }

  get repoHref(): string | null {
    const url = String(this.project?.repositoryUrl || '').trim();
    return /^https?:\/\//.test(url) ? url.replace(/\.git$/, '') : null;
  }

  /** `owner/repo` for the header line, or the URL without the scheme. */
  get repoLabel(): string {
    const href = this.repoHref || '';
    return href.replace(/^https?:\/\/(www\.)?(github\.com|gitlab\.com)\//, '').replace(/^https?:\/\//, '');
  }

  dbTypeLabel(t: string): string {
    const map: Record<string, string> = { postgres: 'PostgreSQL', mongo: 'MongoDB', redis: 'Redis', mysql: 'MySQL' };
    return map[String(t || '').toLowerCase()] || String(t || 'Unknown');
  }

  /** Header "Deploy": open the Deployments section and bring the deploy form into view. */
  openDeployForm() {
    this.switchSection('deployments');
    this.scrollToAnchor('deploy-form', true);
  }

  private scrollToAnchor(id: string, focus = false) {
    setTimeout(() => {
      const el = typeof document !== 'undefined' ? document.getElementById(id) : null;
      if (!el) return;
      el.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
      if (focus) el.querySelector<HTMLElement>('select, input')?.focus({ preventScroll: true });
    });
  }

  /** SDK token create: API allows platform admin, devops and tech_lead. */
  get canCreateSdkTokens(): boolean {
    return this.role === 'admin' || this.role === 'devops' || this.role === 'tech_lead';
  }

  /** SDK token revoke: API allows platform admin and devops. */
  get canRevokeSdkTokens(): boolean {
    return this.role === 'admin' || this.role === 'devops';
  }

  /** Keep the active tab visible in the horizontally scrolling tab bar. */
  scrollActiveTabIntoView() {
    setTimeout(() => {
      const bar = this.tabBar?.nativeElement;
      const active = bar?.querySelector<HTMLElement>('.active');
      if (!bar || !active) return;
      const left = active.offsetLeft; // .subnav is position:relative here (the offsetParent)
      const right = left + active.offsetWidth;
      if (left < bar.scrollLeft) bar.scrollLeft = Math.max(0, left - 16);
      else if (right > bar.scrollLeft + bar.clientWidth) bar.scrollLeft = right - bar.clientWidth + 16;
    });
  }

  switchSection(section: ProjectSection) {
    const changed = section !== this.section;
    const leavingMonitoring = changed && this.section === 'monitoring';
    this.section = section;
    if (changed) {
      const extra: Record<string, string | null> = leavingMonitoring ? Object.fromEntries(MONITORING_PARAMS.map((k) => [k, null])) : {};
      if (section === 'monitoring') extra['view'] = this.monitoringView;
      this.writeTabParam(section, extra);
    }
    this.scrollActiveTabIntoView();
    if (section === 'overview' || section === 'deployments') this.loadDeployments();
    if (section === 'deployments') {
      this.loadK8sPods();
      this.loadArgoStatus();
    }
    if (section === 'monitoring') this.loadMonitoringData();
    if (section === 'data') this.loadBackups();
    if (section === 'settings') this.loadMembers();
  }

  formatBytes(bytes: number): string {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
}
