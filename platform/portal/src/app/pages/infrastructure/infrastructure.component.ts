import { Component, OnInit, OnDestroy, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../services/api.service';
import { ToastService, DialogService, errorText } from '../../shared/feedback/feedback.service';

export interface NodeMetricRow {
  name: string;
  cpuUsedCores: number;
  cpuCapacityCores: number;
  memoryUsedBytes: number;
  memoryCapacityBytes: number;
}

/** One cluster read: answered, API says the cluster is unreachable, or no answer from the API. */
export type PollResult = 'ok' | 'down' | 'noanswer';

/** Two reads of one poll: ok if either answered; down only if the API reported it. */
export function combinePolls(a: PollResult, b: PollResult): PollResult {
  if (a === 'ok' || b === 'ok') return 'ok';
  return a === 'down' || b === 'down' ? 'down' : 'noanswer';
}

@Component({
  selector: 'app-infrastructure',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './infrastructure.component.html',
  styleUrl: './infrastructure.component.css'
})
export class InfrastructureComponent implements OnInit, OnDestroy {
  activeTab = 'nodes'; // nodes, namespaces, pods, bootstrap, metrics

  // Real cluster state. A single failed poll (for example while one server of an HA cluster
  // dies and the API's request lands on it) does not blank the page: the last data stays,
  // marked "Reconnecting", until CLUSTER_FAILURES_BEFORE_DOWN polls in a row fail.
  static readonly CLUSTER_FAILURES_BEFORE_DOWN = 3;
  k8sConnected = false;
  // False until the first poll has been recorded: the page then says "Checking"
  // instead of flashing "Can't reach the cluster" on every visit.
  clusterChecked = false;
  clusterReconnecting = false;
  // The last poll got no answer from Cairn's API itself (timeout, 502/503): the
  // cluster may be fine, e.g. while the API's database fails over.
  apiNoAnswer = false;
  lastClusterOkAt: Date | null = null;
  private clusterFailures = 0;
  private podsLoadedFor: string | null = null;
  nodes: any[] = [];
  namespaces: any[] = [];
  pods: any[] = [];
  bootstrapHistory: any[] = [];

  // System Health state
  // Unknown until the first status answer (not "disconnected": the page loads
  // before the API has answered, and a healthy cluster must not look down).
  systemStatus = {
    postgres: 'unknown',
    mongodb: 'unknown',
    k8s: 'unknown',
    services: {
      loki: 'offline',
      prometheus: 'offline',
      grafana: 'offline',
      argocd: 'offline'
    }
  };

  // Namespace filtering
  selectedNamespace = 'all';

  // Logs terminal modal state
  showLogsModal = false;
  selectedPodName = '';
  selectedPodNamespace = '';
  podLogsText = '';
  loadingLogs = false;

  // Live node metrics from metrics-server (never simulated)
  metricsAvailable = false;
  metricsFetched = false;
  nodeMetrics: NodeMetricRow[] = [];
  metricsLoading = false;

  // Background polling timers
  private pollInterval?: ReturnType<typeof setInterval>;
  private metricsInterval?: ReturnType<typeof setInterval>;
  private logPollInterval?: ReturnType<typeof setInterval>;

  private toast = inject(ToastService);
  private dialog = inject(DialogService);

  constructor(private api: ApiService) {}

  async ngOnInit() {
    await this.refreshAllData();

    // Start background poll every 8 seconds
    this.pollInterval = setInterval(() => this.refreshAllData(), 8000);
  }

  ngOnDestroy() {
    if (this.pollInterval) clearInterval(this.pollInterval);
    this.stopMetricsPolling();
    if (this.logPollInterval) clearInterval(this.logPollInterval);
  }

  selectTab(tab: string) {
    this.activeTab = tab;
    if (tab === 'pods') {
      this.loadPods();
    }
    if (tab === 'metrics') {
      this.startMetricsPolling();
    } else {
      this.stopMetricsPolling();
    }
  }

  async refreshAllData() {
    const [, nodesOk, , podsOk] = await Promise.all([
      this.loadSystemStatus(),
      this.loadNodes(),
      this.loadNamespaces(),
      this.loadPods(false),
      this.loadBootstrapHistory()
    ]);
    // One poll = one observation: the cluster answered if either cluster read succeeded;
    // it is down only if the API answered that it is.
    this.noteCluster(combinePolls(nodesOk, podsOk));
  }

  /** Records one cluster poll result; keeps the last data through short outages. */
  noteCluster(result: boolean | PollResult) {
    const r: PollResult = result === true ? 'ok' : result === false ? 'down' : result;
    this.clusterChecked = true;
    if (r === 'ok') {
      this.clusterFailures = 0;
      this.k8sConnected = true;
      this.clusterReconnecting = false;
      this.apiNoAnswer = false;
      this.lastClusterOkAt = new Date();
      return;
    }
    this.apiNoAnswer = r === 'noanswer';
    // No answer from the API says nothing about the cluster: keep the last data
    // as "Reconnecting" instead of reporting a cluster outage (a database failover
    // made both API pods unready for ~30 s on a 3-server cluster).
    if (r === 'noanswer' && this.lastClusterOkAt) {
      this.clusterReconnecting = true;
      return;
    }
    this.clusterFailures++;
    if (this.lastClusterOkAt && this.clusterFailures < InfrastructureComponent.CLUSTER_FAILURES_BEFORE_DOWN) {
      this.clusterReconnecting = true;
      return;
    }
    this.k8sConnected = false;
    this.clusterReconnecting = false;
  }

  async loadSystemStatus() {
    try {
      this.systemStatus = await firstValueFrom(this.api.getBootstrapStatus());
    } catch {
      this.systemStatus.postgres = 'disconnected';
      this.systemStatus.k8s = 'disconnected';
    }
  }

  /** Returns whether the cluster answered; keeps the last servers list when it did not. */
  async loadNodes(): Promise<PollResult> {
    try {
      const res = await firstValueFrom(this.api.getNodes());
      if (!res.k8sConnected) return 'down';
      this.nodes = res.nodes || [];
      return 'ok';
    } catch {
      return 'noanswer';
    }
  }

  async loadNamespaces() {
    try {
      const res = await firstValueFrom(this.api.getNamespaces());
      // An empty answer from an unreachable cluster must not wipe the list.
      if (res.k8sConnected === false && this.namespaces.length) return;
      this.namespaces = res.namespaces || [];
    } catch {
      // keep the last list
    }
  }

  /** Returns whether the cluster answered. `report` records the result when called on its own. */
  async loadPods(report = true): Promise<PollResult> {
    const requested = this.selectedNamespace;
    let result: PollResult = 'down';
    try {
      const ns = requested === 'all' ? undefined : requested;
      const res = await firstValueFrom(this.api.getPods(ns));
      if (res.k8sConnected) {
        this.pods = res.pods || [];
        this.podsLoadedFor = requested;
        result = 'ok';
      }
    } catch {
      result = 'noanswer';
    }
    // Last data is only kept for the same filter; never show another namespace's pods.
    if (result !== 'ok' && this.podsLoadedFor !== requested) this.pods = [];
    if (report) this.noteCluster(result);
    return result;
  }

  async loadBootstrapHistory() {
    try {
      this.bootstrapHistory = await firstValueFrom(this.api.getBootstrapHistory());
    } catch {
      this.bootstrapHistory = [];
    }
  }

  async loadNodeMetrics() {
    this.metricsLoading = true;
    try {
      const res = await firstValueFrom(this.api.getNodeMetrics());
      // The main poll owns outage detection; a metrics answer only confirms reachability.
      if (res.k8sConnected) this.noteCluster(true);
      this.metricsAvailable = !!res.metricsAvailable;
      this.nodeMetrics = Array.isArray(res.nodes) ? res.nodes : [];
    } catch {
      this.metricsAvailable = false;
      this.nodeMetrics = [];
    } finally {
      this.metricsLoading = false;
      this.metricsFetched = true;
    }
  }

  startMetricsPolling() {
    this.stopMetricsPolling();
    void this.loadNodeMetrics();
    this.metricsInterval = setInterval(() => this.loadNodeMetrics(), 15000);
  }

  stopMetricsPolling() {
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
      this.metricsInterval = undefined;
    }
  }

  /**
   * Dot colour for a dependency status from GET /bootstrap/status ("running", "degraded",
   * "offline", "unknown"; older APIs said "connected"/"disconnected").
   */
  serviceStatusClass(status: string | null | undefined): string {
    switch ((status || '').toLowerCase()) {
      case 'running':
      case 'connected':
      case 'healthy':
        return 'status-ok';
      case 'degraded':
      case 'pending':
        return 'status-warn';
      case 'offline':
      case 'disconnected':
      case 'down':
      case 'error':
        return 'status-down';
      default:
        return '';
    }
  }

  cpuPct(n: NodeMetricRow): number {
    if (!n.cpuCapacityCores) return 0;
    return Math.min(100, Math.max(0, (n.cpuUsedCores / n.cpuCapacityCores) * 100));
  }

  memoryPct(n: NodeMetricRow): number {
    if (!n.memoryCapacityBytes) return 0;
    return Math.min(100, Math.max(0, (n.memoryUsedBytes / n.memoryCapacityBytes) * 100));
  }

  formatCores(v: number): string {
    if (!Number.isFinite(v)) return '—';
    return v < 1 ? `${(v * 1000).toFixed(0)}m` : `${v.toFixed(2)}`;
  }

  formatBytes(v: number): string {
    if (!Number.isFinite(v) || v < 0) return '—';
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let n = v;
    let i = 0;
    while (n >= 1024 && i < units.length - 1) {
      n /= 1024;
      i++;
    }
    return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  // Pod actions
  async openPodLogs(pod: any) {
    this.selectedPodName = pod.name;
    this.selectedPodNamespace = pod.namespace;
    this.showLogsModal = true;
    this.podLogsText = 'Connecting to pod container logs...';
    await this.fetchPodLogs();

    // Set up active log tail polling
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
      await this.loadPods();
    } catch (err: any) {
      this.toast.error('Pod was not restarted: ' + errorText(err));
    }
  }
}
