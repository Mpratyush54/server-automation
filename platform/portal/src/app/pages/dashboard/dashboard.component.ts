import { Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.css'
})
export class DashboardComponent implements OnInit, OnDestroy {
  stats = { projects: 0, deployments: 0, services: 0, namespaces: 6, podsText: '0 / 0', podsProgress: 0 };
  recentDeployments: any[] = [];
  systemHealth: any[] = [];
  projectsList: any[] = [];
  grafanaEmbedUrl!: SafeResourceUrl;
  grafanaFullUrl = '/grafana/';
  showIframe = false;
  iframeLoaded = false;
  iframeFailed = false;
  platformVersion: string = '';
  releasesUrl: string = '';
  updateAvailable = false;
  latestRelease: any = null;

  /** Platform SDK telemetry (works without Grafana auth) */
  telemetryWindow: '1h' | '24h' = '1h';
  telemetryLoading = true;
  telemetryError = '';
  telemetry = {
    heartbeats: 0,
    cpuAvg: 0,
    memoryAvg: 0,
    projectsWithData: 0,
    series: [] as { t: number; cpu: number; mem: number }[],
    sparkPath: '',
  };
  private telemetryTimer?: ReturnType<typeof setInterval>;

  constructor(private api: ApiService, private sanitizer: DomSanitizer, private auth: AuthService) {}

  async ngOnInit() {
    const domain = window.location.hostname || 'localhost';
    // Same-origin Grafana subpath (HTTPS). Solo panels need a logged-in Grafana session;
    // we still offer the link, and show SDK metrics as the reliable home telemetry.
    this.grafanaFullUrl = domain === 'localhost' ? 'http://localhost:3000/grafana/' : '/grafana/';
    this.grafanaEmbedUrl = this.sanitizer.bypassSecurityTrustResourceUrl(
      `${this.grafanaFullUrl}d-solo/rYy79FwVz/kubernetes-compute-resources-cluster?orgId=1&panelId=1&theme=dark`,
    );

    try {
      const projects = await firstValueFrom(this.api.getProjects()) as any[];
      this.projectsList = projects;
      this.stats.projects = projects.length;

      this.recentDeployments = projects
        .flatMap((p: any) => (p.deployments || []).map((d: any) => ({ ...d, projectName: p.name })))
        .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 10);

      this.stats.deployments = this.recentDeployments.filter((d: any) => d.status === 'active' || d.status === 'success').length;
    } catch {
      this.stats.projects = 0;
      this.projectsList = [];
    }

    const projectNamespaces = new Set<string>();
    const projectNames = this.projectsList.map(p => p.name.toLowerCase());

    this.projectsList.forEach((p: any) => {
      if (p.environments) {
        p.environments.forEach((e: any) => {
          if (e.namespace) projectNamespaces.add(e.namespace.toLowerCase());
        });
      }
    });

    const hasPreview = this.recentDeployments.some(d => d.environment === 'preview' || d.environmentId === 'preview');
    if (hasPreview) projectNamespaces.add('preview');
    this.stats.namespaces = projectNamespaces.size;

    let runningPods = 0;
    let totalPods = 0;
    if ((this.auth.isDevOps() || this.auth.isAdmin()) && this.projectsList.length > 0) {
      try {
        const podsRes = await firstValueFrom(this.api.getPods());
        const pods = podsRes.pods || [];
        const filteredPods = pods.filter((pod: any) => {
          const podNs = pod.namespace.toLowerCase();
          const podName = pod.name.toLowerCase();
          if (projectNamespaces.has(podNs)) {
            if (podNs === 'preview') return projectNames.some(pName => podName.includes(pName));
            return true;
          }
          return projectNames.some(pName => podName.includes(pName) || podNs.includes(pName));
        });
        totalPods = filteredPods.length;
        runningPods = filteredPods.filter((p: any) => p.status === 'Running' || p.status === 'running').length;
      } catch {}
    }
    this.stats.podsText = `${runningPods} / ${totalPods}`;
    this.stats.podsProgress = totalPods > 0 ? Math.round((runningPods / totalPods) * 100) : 0;

    try {
      const status = await firstValueFrom(this.api.getBootstrapStatus()) as any;
      this.systemHealth = Object.entries(status.services || {}).map(([name, s]) => ({ name, status: s }));
      this.stats.services = this.systemHealth.filter(s => s.status === 'running').length;
    } catch {
      this.stats.services = 0;
      this.systemHealth = [];
    }

    try {
      const ver = await firstValueFrom(this.api.getPlatformVersion()) as any;
      this.platformVersion = ver.imageTag || ver.platformVersion || '';
      this.releasesUrl = ver.releases || '';
      this.updateAvailable = !!ver.updateAvailable;
      this.latestRelease = ver.latestRelease || null;
    } catch {
      this.platformVersion = '';
    }

    await this.loadTelemetry();
    this.telemetryTimer = setInterval(() => this.loadTelemetry(), 15000);
  }

  ngOnDestroy() {
    if (this.telemetryTimer) clearInterval(this.telemetryTimer);
  }

  setTelemetryWindow(w: '1h' | '24h') {
    this.telemetryWindow = w;
    this.loadTelemetry();
  }

  async loadTelemetry() {
    this.telemetryLoading = true;
    this.telemetryError = '';
    try {
      const projects = this.projectsList.slice(0, 12);
      if (!projects.length) {
        this.telemetry = {
          heartbeats: 0, cpuAvg: 0, memoryAvg: 0, projectsWithData: 0, series: [], sparkPath: '',
        };
        this.telemetryLoading = false;
        return;
      }

      const results = await Promise.all(
        projects.map(async (p: any) => {
          try {
            const [raw, agg] = await Promise.all([
              firstValueFrom(this.api.getMetrics(p.id)),
              firstValueFrom(this.api.getAggregatedMetrics(p.id)),
            ]);
            return { raw: Array.isArray(raw) ? raw : [], agg: agg || {} };
          } catch {
            return { raw: [], agg: {} };
          }
        }),
      );

      const cutoff = Date.now() - (this.telemetryWindow === '1h' ? 3600_000 : 86400_000);
      const points: { t: number; cpu: number; mem: number }[] = [];
      let hb = 0;
      let cpuSum = 0;
      let memSum = 0;
      let nAgg = 0;
      let withData = 0;

      for (const r of results) {
        const recent = r.raw.filter((m: any) => {
          const t = new Date(m.timestamp || m.createdAt || 0).getTime();
          return t >= cutoff;
        });
        if (recent.length) withData++;
        hb += recent.length;
        for (const m of recent) {
          points.push({
            t: new Date(m.timestamp || m.createdAt).getTime(),
            cpu: Number(m.cpuPct || 0),
            mem: Number(m.memoryMb || 0),
          });
        }
        if (r.agg.cpuAvg || r.agg.memoryAvg) {
          cpuSum += Number(r.agg.cpuAvg || 0);
          memSum += Number(r.agg.memoryAvg || 0);
          nAgg++;
        }
      }

      points.sort((a, b) => a.t - b.t);
      const series = points.slice(-40);
      this.telemetry = {
        heartbeats: hb,
        cpuAvg: nAgg ? cpuSum / nAgg : (series.reduce((s, p) => s + p.cpu, 0) / (series.length || 1)),
        memoryAvg: nAgg ? memSum / nAgg : (series.reduce((s, p) => s + p.mem, 0) / (series.length || 1)),
        projectsWithData: withData,
        series,
        sparkPath: this.buildSparkPath(series.map((p) => p.cpu)),
      };
    } catch (e: any) {
      this.telemetryError = e.message || 'Failed to load telemetry';
    } finally {
      this.telemetryLoading = false;
    }
  }

  private buildSparkPath(values: number[]): string {
    if (!values.length) return '';
    const w = 600;
    const h = 120;
    const max = Math.max(...values, 1);
    return values
      .map((v, i) => {
        const x = (i / Math.max(values.length - 1, 1)) * w;
        const y = h - (v / max) * (h - 8) - 4;
        return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(' ');
  }

  onIframeLoad() {
    this.iframeLoaded = true;
  }

  onIframeError() {
    this.iframeFailed = true;
    this.showIframe = false;
  }
}
