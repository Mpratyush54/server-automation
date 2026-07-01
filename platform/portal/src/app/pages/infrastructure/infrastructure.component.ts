import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../services/api.service';

@Component({
  selector: 'app-infrastructure',
  standalone: true,
  imports: [CommonModule, FormsModule],
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
      infisical: 'offline',
      argocd: 'offline'
    }
  };

  // Namespace filtering
  selectedNamespace = 'all';

  // Join token variables
  joinToken = '';
  joinCommand = '';
  loadingToken = false;

  // Logs terminal modal state
  showLogsModal = false;
  selectedPodName = '';
  selectedPodNamespace = '';
  podLogsText = '';
  loadingLogs = false;

  // Real-time metric series (wiggling SVG chart inputs)
  cpuHistory: number[] = Array.from({ length: 24 }, () => 10 + Math.random() * 12);
  memoryHistory: number[] = Array.from({ length: 24 }, () => 32 + Math.random() * 6);
  networkHistory: number[] = Array.from({ length: 24 }, () => 200 + Math.random() * 150);
  chartLabels: string[] = Array.from({ length: 24 }, (_, i) => `${24 - i}m ago`);

  // SVG Paths
  cpuPath = '';
  cpuAreaPath = '';
  memoryPath = '';
  memoryAreaPath = '';
  networkPath = '';
  networkAreaPath = '';

  // Background polling timers
  private pollInterval?: any;
  private metricsInterval?: any;
  private logPollInterval?: any;

  constructor(private api: ApiService) {}

  async ngOnInit() {
    await this.refreshAllData();
    this.generateSvgPaths();

    // Start background poll every 8 seconds
    this.pollInterval = setInterval(() => this.refreshAllData(), 8000);

    // Wiggle metrics dashboard every 3 seconds
    this.metricsInterval = setInterval(() => {
      this.wiggleMetrics();
    }, 3000);
  }

  ngOnDestroy() {
    if (this.pollInterval) clearInterval(this.pollInterval);
    if (this.metricsInterval) clearInterval(this.metricsInterval);
    if (this.logPollInterval) clearInterval(this.logPollInterval);
  }

  selectTab(tab: string) {
    this.activeTab = tab;
    if (tab === 'pods') {
      this.loadPods();
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
      this.nodes = res.nodes || [];
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
      this.pods = res.pods || [];
      this.k8sConnected = res.k8sConnected;
    } catch {
      this.pods = [];
    }
  }

  async loadBootstrapHistory() {
    try {
      this.bootstrapHistory = await firstValueFrom(this.api.getBootstrapHistory());
    } catch {
      this.bootstrapHistory = [];
    }
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
    if (!confirm(`Are you sure you want to terminate and restart pod "${pod.name}" in namespace "${pod.namespace}"?`)) {
      return;
    }
    try {
      await firstValueFrom(this.api.deletePod(pod.namespace, pod.name));
      alert(`Pod deletion command sent. Pod will be restarted by the deployment controller.`);
      await this.loadPods();
    } catch (err: any) {
      alert(`Failed to restart pod: ${err.error?.error || err.message}`);
    }
  }

  // Join command for nodes
  async generateJoinToken() {
    this.loadingToken = true;
    try {
      const res: any = await firstValueFrom(this.api.getBootstrapToken());
      this.joinToken = res.token;
      this.joinCommand = `curl https://platform.platform.dev/bootstrap/get | bash -s -- --token ${this.joinToken} --master 104.21.32.14`;
    } catch (err: any) {
      alert('Failed to generate join token: ' + (err.error?.error || err.message));
    } finally {
      this.loadingToken = false;
    }
  }

  // Wiggle / Update metrics history
  wiggleMetrics() {
    // Add real-time wiggling values
    const lastCpu = this.cpuHistory[this.cpuHistory.length - 1];
    const lastMem = this.memoryHistory[this.memoryHistory.length - 1];
    const lastNet = this.networkHistory[this.networkHistory.length - 1];

    const newCpu = Math.max(5, Math.min(95, lastCpu + (Math.random() * 8 - 4)));
    const newMem = Math.max(5, Math.min(95, lastMem + (Math.random() * 2 - 1)));
    const newNet = Math.max(50, Math.min(800, lastNet + (Math.random() * 100 - 50)));

    this.cpuHistory.push(newCpu);
    this.cpuHistory.shift();
    this.memoryHistory.push(newMem);
    this.memoryHistory.shift();
    this.networkHistory.push(newNet);
    this.networkHistory.shift();

    this.generateSvgPaths();
  }

  generateSvgPaths() {
    const width = 600;
    const height = 200;
    const padding = 15;
    const pointsCount = this.cpuHistory.length;
    const step = (width - padding * 2) / (pointsCount - 1);

    const makePaths = (data: number[], maxVal: number) => {
      const linePoints = [];
      for (let i = 0; i < data.length; i++) {
        const x = padding + i * step;
        const valPct = data[i] / maxVal;
        const y = height - padding - valPct * (height - padding * 2);
        linePoints.push(`${x.toFixed(1)},${y.toFixed(1)}`);
      }
      const linePath = 'M ' + linePoints.join(' L ');
      const areaPath = `${linePath} L ${(padding + (data.length - 1) * step).toFixed(1)},${(height - padding).toFixed(1)} L ${padding.toFixed(1)},${(height - padding).toFixed(1)} Z`;
      return { linePath, areaPath };
    };

    // Max CPU is 100%
    const cpuPaths = makePaths(this.cpuHistory, 100);
    this.cpuPath = cpuPaths.linePath;
    this.cpuAreaPath = cpuPaths.areaPath;

    // Max Memory is 100%
    const memPaths = makePaths(this.memoryHistory, 100);
    this.memoryPath = memPaths.linePath;
    this.memoryAreaPath = memPaths.areaPath;

    // Max Network is 1000 Mbps
    const netPaths = makePaths(this.networkHistory, 1000);
    this.networkPath = netPaths.linePath;
    this.networkAreaPath = netPaths.areaPath;
  }
}
