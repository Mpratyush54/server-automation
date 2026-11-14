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

@Component({
  selector: 'app-infrastructure',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './infrastructure.component.html',
  styleUrl: './infrastructure.component.css'
})
export class InfrastructureComponent implements OnInit, OnDestroy {
  activeTab = 'nodes'; // nodes, namespaces, pods, bootstrap, metrics

  // Real cluster state
  k8sConnected = false;
  nodes: any[] = [];
  namespaces: any[] = [];
  pods: any[] = [];
  bootstrapHistory: any[] = [];

  // System Health state
  systemStatus = {
    postgres: 'disconnected',
    mongodb: 'disconnected',
    k8s: 'disconnected',
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
    await Promise.allSettled([
      this.loadSystemStatus(),
      this.loadNodes(),
      this.loadNamespaces(),
      this.loadPods(),
      this.loadBootstrapHistory()
    ]);
  }

  async loadSystemStatus() {
    try {
      this.systemStatus = await firstValueFrom(this.api.getBootstrapStatus());
    } catch {
      this.systemStatus.postgres = 'disconnected';
      this.systemStatus.k8s = 'disconnected';
    }
  }

  async loadNodes() {
    try {
      const res = await firstValueFrom(this.api.getNodes());
      this.nodes = res.k8sConnected ? res.nodes || [] : [];
      this.k8sConnected = res.k8sConnected;
    } catch {
      this.nodes = [];
      this.k8sConnected = false;
    }
  }

  async loadNamespaces() {
    try {
      const res = await firstValueFrom(this.api.getNamespaces());
      this.namespaces = res.namespaces || [];
    } catch {
      this.namespaces = [];
    }
  }

  async loadPods() {
    try {
      const ns = this.selectedNamespace === 'all' ? undefined : this.selectedNamespace;
      const res = await firstValueFrom(this.api.getPods(ns));
      this.pods = res.k8sConnected ? res.pods || [] : [];
      this.k8sConnected = res.k8sConnected;
    } catch {
      this.pods = [];
      this.k8sConnected = false;
    }
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
      this.k8sConnected = !!res.k8sConnected;
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
