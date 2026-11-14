import { Component, OnInit } from '@angular/core';

import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../services/api.service';

interface IntegrationItem {
  key: string;
  label: string;
  description: string;
  docsUrl: string;
  webhookPath?: string;
  configured: boolean;
  envVars: string[];
}

@Component({
  selector: 'app-bootstrap',
  standalone: true,
  imports: [FormsModule, RouterLink],
  templateUrl: './bootstrap.component.html',
  styleUrl: './bootstrap.component.css',
})
export class BootstrapComponent implements OnInit {
  tab = 'start';
  copied = false;
  loadingStatus = false;
  statusServices: any[] = [];
  platformUrl = window.location.origin.replace(':4200', ':3000');

  installCmd = `curl -fsSL https://github.com/Mpratyush54/SERVER-automation/releases/latest/download/install.sh | bash
sudo platformctl provision`;

  integrations: IntegrationItem[] = [
    {
      key: 'github',
      label: 'GitHub',
      description: 'Auto-deploy on push, webhook-driven PR previews, package registry',
      docsUrl: 'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens',
      webhookPath: '/api/webhooks/github',
      configured: false,
      envVars: ['GITHUB_TOKEN', 'GITHUB_ORG'],
    },
    {
      key: 'gitlab',
      label: 'GitLab',
      description: 'GitLab CI/CD pipeline triggers, MR preview environments',
      docsUrl: 'https://docs.gitlab.com/ee/user/profile/personal_access_tokens.html',
      webhookPath: '/api/webhooks/gitlab',
      configured: false,
      envVars: ['GITLAB_TOKEN', 'GITLAB_URL'],
    },
    {
      key: 'clickup',
      label: 'ClickUp',
      description: 'Link deployments to tasks, auto-create tasks from bug reports',
      docsUrl: 'https://clickup.com/api/developer-portal/authentication',
      configured: false,
      envVars: ['CLICKUP_API_TOKEN', 'CLICKUP_TEAM_ID'],
    },
    {
      key: 'smtp',
      label: 'SMTP / Email',
      description: 'Deployment success/failure emails, backup notifications',
      docsUrl: 'https://nodemailer.com/smtp/',
      configured: false,
      envVars: ['SMTP_PROVIDER', 'SMTP_FROM_EMAIL'],
    },
    {
      key: 'argocd',
      label: 'ArgoCD',
      description: 'GitOps continuous delivery, auto-sync from Git on every push',
      docsUrl: 'https://argo-cd.readthedocs.io',
      configured: false,
      envVars: ['ARGOCD_URL', 'ARGOCD_TOKEN'],
    },
    {
      key: 'minio',
      label: 'MinIO / S3',
      description: 'Database backup storage target — MinIO bundled, or bring your own S3',
      docsUrl: 'https://min.io/docs/minio/kubernetes/upstream',
      configured: false,
      envVars: ['MINIO_ENDPOINT', 'MINIO_ACCESS_KEY'],
    },
    {
      key: 'grafana',
      label: 'Grafana',
      description: 'Metrics dashboards with Prometheus + Loki log explorer',
      docsUrl: 'https://grafana.com/docs',
      configured: false,
      envVars: ['GRAFANA_URL'],
    },
  ];

  constructor(private api: ApiService) {}

  ngOnInit() {
    this.platformUrl = window.location.origin.includes('4200')
      ? window.location.origin.replace('4200', '3000')
      : window.location.origin;
  }

  async loadStatus() {
    this.loadingStatus = true;
    try {
      const res = await firstValueFrom(this.api.getBootstrapStatus()) as any;
      const services = res?.services || {};

      // Map to display list
      this.statusServices = [
        { label: 'Platform API',      namespace: 'platform', status: services['platform-api']      || 'unknown', detail: 'Backend REST API' },
        { label: 'Platform Portal',   namespace: 'platform', status: services['platform-portal']   || 'unknown', detail: 'Angular Frontend' },
        { label: 'PostgreSQL',    namespace: 'databases',      status: services['postgresql']    || 'unknown', detail: 'Primary database' },
        { label: 'MongoDB',       namespace: 'databases',      status: services['mongodb']       || 'unknown', detail: 'Log & metrics store' },
        { label: 'Redis',         namespace: 'databases',      status: services['redis']         || 'unknown', detail: 'Cache & session store' },
        { label: 'MinIO',         namespace: 'storage',        status: services['minio']         || 'unknown', detail: 'Backup object storage' },
        { label: 'ArgoCD',        namespace: 'argocd',         status: services['argocd']        || 'unknown', detail: 'GitOps controller' },
        { label: 'Grafana',       namespace: 'monitoring',     status: services['grafana']       || 'unknown', detail: 'Metrics dashboards' },
        { label: 'Prometheus',    namespace: 'monitoring',     status: services['prometheus']    || 'unknown', detail: 'Metrics collection' },
        { label: 'Loki',          namespace: 'monitoring',     status: services['loki']          || 'unknown', detail: 'Log aggregation' },
        { label: 'Portainer',     namespace: 'portainer',      status: services['portainer']     || 'unknown', detail: 'Container management' },
        { label: 'ingress-nginx', namespace: 'ingress-nginx',  status: services['ingress-nginx'] || 'unknown', detail: 'HTTP routing' },
        { label: 'cert-manager',  namespace: 'cert-manager',   status: services['cert-manager']  || 'unknown', detail: 'TLS certificates' },
      ];

      // Also update integration configured status from backend env check
      if (res?.integrations) {
        this.integrations.forEach(i => {
          i.configured = !!res.integrations[i.key];
        });
      }
    } catch {
      // Show all as unknown if API not reachable
      this.statusServices = this.statusServices.map(s => ({ ...s, status: 'unknown' }));
    }
    this.loadingStatus = false;
  }

  copyInstallCmd() {
    navigator.clipboard.writeText(this.installCmd).catch(() => {});
    this.copied = true;
    setTimeout(() => this.copied = false, 2000);
  }

}
