import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  ProjectSection, StatusView, currentDeployment, deploymentStatus, sortDeployments, statusClass,
} from './project-sections';

interface EnvRow {
  env: any;
  current: any | null;
  url: string | null;
}

/** Overview section (#185): what is deployed where, recent activity, key facts. */
@Component({
  selector: 'app-project-overview',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './project-overview.component.html',
  styleUrl: './project-overview.component.css',
})
export class ProjectOverviewComponent {
  @Input() project: any;
  @Input() deployments: any[] = [];
  @Input() members: any[] = [];
  @Input() argoStatus: any = null;
  @Input() aggregatedMetrics: any = null;
  @Input() metricsCount = 0;
  @Input() observabilityEnabled = false;
  @Output() navigate = new EventEmitter<ProjectSection>();

  readonly statusClass = statusClass;

  get envRows(): EnvRow[] {
    return (this.project?.environments || []).map((env: any) => {
      const current = currentDeployment(this.deployments, env.id);
      return { env, current, url: this.envUrl(env, current) };
    });
  }

  get recent(): any[] {
    return sortDeployments(this.deployments).slice(0, 5);
  }

  get namespaces(): string[] {
    return (this.project?.environments || []).map((e: any) => e.namespace).filter(Boolean);
  }

  depStatus(dep: any): StatusView {
    return deploymentStatus(dep?.status);
  }

  envName(environmentId: string | null): string {
    const env = (this.project?.environments || []).find((e: any) => e.id === environmentId);
    return env?.name || (environmentId ? 'Unknown environment' : 'No environment');
  }

  /** Deployment author from the member list; the API only returns `deployedById`. */
  who(dep: any): string {
    if (!dep?.deployedById) return 'Not recorded';
    const m = (this.members || []).find((x: any) => x.userId === dep.deployedById || x.user?.id === dep.deployedById);
    return m?.user?.name || m?.user?.email || 'Unknown user';
  }

  shortSha(sha?: string): string {
    return sha ? String(sha).slice(0, 7) : '';
  }

  private envUrl(env: any, dep: any): string | null {
    if (env?.domain) return /^https?:\/\//.test(env.domain) ? env.domain : `https://${env.domain}`;
    return dep?.previewUrl || null;
  }

  get repoHref(): string | null {
    const url = String(this.project?.repositoryUrl || '').trim();
    if (!/^https?:\/\//.test(url)) return null;
    return url.replace(/\.git$/, '');
  }

  get argoTone(): StatusView | null {
    if (!this.argoStatus) return null;
    const health = String(this.argoStatus.healthStatus || 'Unknown');
    const sync = String(this.argoStatus.syncStatus || 'Unknown');
    if (this.argoStatus.connected === false) return { label: 'Not connected', tone: 'neutral' };
    if (health === 'Degraded' || health === 'Missing') return { label: `${health}, ${sync}`, tone: 'down' };
    if (health === 'Progressing' || sync === 'OutOfSync') return { label: `${health}, ${sync}`, tone: 'warn' };
    if (health === 'Healthy' && sync === 'Synced') return { label: 'Healthy, synced', tone: 'ok' };
    return { label: `${health}, ${sync}`, tone: 'neutral' };
  }
}
