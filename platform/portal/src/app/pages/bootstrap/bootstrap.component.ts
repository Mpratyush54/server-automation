import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../services/api.service';

interface IntegrationItem {
  key: string;
  label: string;
  icon: string;
  description: string;
  docsUrl: string;
  webhookPath?: string;
  configured: boolean;
  envVars: string[];
}

@Component({
  selector: 'app-bootstrap',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  template: `
<div>
  <!-- Header -->
  <div class="card" style="background:linear-gradient(135deg,rgba(99,102,241,0.08),rgba(139,92,246,0.08));border-color:rgba(99,102,241,0.25);margin-bottom:24px;">
    <h1 style="margin:0 0 6px;font-size:1.6rem;background:linear-gradient(to right,#fff,#94a3b8);-webkit-background-clip:text;-webkit-text-fill-color:transparent;">🚀 Server Bootstrap</h1>
    <p style="margin:0;color:var(--color-text-secondary);font-size:0.9rem;">Get a fresh Ubuntu server running Platform end-to-end with a single command.</p>
  </div>

  <!-- Tab Bar -->
  <div style="display:flex;gap:8px;margin-bottom:24px;border-bottom:1px solid var(--border-glass);padding-bottom:12px;flex-wrap:wrap;">
    <button class="btn btn-sm" [class.btn-primary]="tab==='start'" (click)="tab='start'">🚀 Quick Start</button>
    <button class="btn btn-sm" [class.btn-primary]="tab==='integrations'" (click)="tab='integrations';loadStatus()">🔗 Integrations</button>
    <button class="btn btn-sm" [class.btn-primary]="tab==='status'" (click)="tab='status';loadStatus()">💚 System Status</button>
    <button class="btn btn-sm" [class.btn-primary]="tab==='script'" (click)="tab='script'">📜 Full Script</button>
  </div>

  <!-- ─── QUICK START TAB ─────────────────────────────────────────────────── -->
  <div *ngIf="tab === 'start'">

    <!-- One-liner command -->
    <div class="card" style="padding:24px;background:rgba(0,0,0,0.35);border-color:rgba(99,102,241,0.3);margin-bottom:20px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <h2 style="margin:0;border:0;padding:0;font-size:1rem;color:#c4b5fd;">⚡ One-Command Install</h2>
        <span style="font-size:0.72rem;color:var(--color-text-muted);background:rgba(16,185,129,0.1);color:#34d399;padding:3px 10px;border-radius:12px;font-weight:600;">Ubuntu 22.04+</span>
      </div>
      <div style="position:relative;">
        <pre style="background:#0b0f19;padding:18px 20px;border-radius:10px;font-size:0.84rem;color:#34d399;margin:0;overflow-x:auto;border:1px solid rgba(52,211,153,0.15);">curl -fsSL https://raw.githubusercontent.com/your-org/platform/main/platform-bootstrap/bootstrap.sh -o bootstrap.sh
chmod +x bootstrap.sh
sudo ./bootstrap.sh</pre>
        <button class="btn btn-sm" (click)="copyInstallCmd()" style="position:absolute;top:10px;right:10px;font-size:0.72rem;">
          {{ copied ? '✓ Copied' : '📋 Copy' }}
        </button>
      </div>
      <p style="color:var(--color-text-secondary);font-size:0.8rem;margin:12px 0 0 0;">The script is fully interactive — it will walk you through every configuration step, including integrations.</p>
    </div>

    <!-- Phase cards -->
    <h2 style="font-size:1rem;margin:0 0 16px;color:#94a3b8;letter-spacing:0.05em;text-transform:uppercase;">What Gets Installed</h2>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px;margin-bottom:24px;">
      <div *ngFor="let phase of phases" class="card" style="padding:16px;margin:0;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
          <span style="font-size:1.3rem;">{{ phase.icon }}</span>
          <div>
            <div style="font-weight:700;font-size:0.88rem;color:#f1f5f9;">{{ phase.name }}</div>
            <div style="font-size:0.7rem;color:#6366f1;font-weight:600;text-transform:uppercase;">Phase {{ phase.phase }}</div>
          </div>
        </div>
        <p style="margin:0;font-size:0.78rem;color:var(--color-text-secondary);line-height:1.5;">{{ phase.desc }}</p>
      </div>
    </div>

    <!-- Requirements -->
    <div class="card" style="padding:20px;background:rgba(245,158,11,0.04);border-color:rgba(245,158,11,0.2);">
      <h2 style="margin:0 0 12px;border:0;padding:0;font-size:0.95rem;color:#f59e0b;">📋 Server Requirements</h2>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:0.82rem;">
        <div style="color:var(--color-text-secondary);">Operating System</div><div style="color:#f1f5f9;font-weight:600;">Ubuntu 22.04 LTS</div>
        <div style="color:var(--color-text-secondary);">CPU (minimum)</div><div style="color:#f1f5f9;font-weight:600;">4 cores</div>
        <div style="color:var(--color-text-secondary);">RAM (minimum)</div><div style="color:#f1f5f9;font-weight:600;">8 GB</div>
        <div style="color:var(--color-text-secondary);">Disk (minimum)</div><div style="color:#f1f5f9;font-weight:600;">80 GB SSD</div>
        <div style="color:var(--color-text-secondary);">Ports required</div><div style="color:#f1f5f9;font-weight:600;">80, 443 (inbound)</div>
        <div style="color:var(--color-text-secondary);">Privileges</div><div style="color:#f1f5f9;font-weight:600;">root / sudo</div>
      </div>
    </div>
  </div>

  <!-- ─── INTEGRATIONS TAB ────────────────────────────────────────────────── -->
  <div *ngIf="tab === 'integrations'">
    <p style="color:var(--color-text-secondary);font-size:0.85rem;margin:0 0 20px 0;">
      These integrations are configured during bootstrap or can be updated any time via
      <a routerLink="/settings" style="color:var(--primary);text-decoration:none;">⚙️ Settings</a>.
      The bootstrap script's <strong>Phase 2 menu</strong> walks through each one interactively.
    </p>

    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px;">
      <div *ngFor="let item of integrations" class="card" style="padding:20px;margin:0;"
        [style.border-color]="item.configured ? 'rgba(16,185,129,0.3)' : 'var(--border-glass)'">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px;">
          <div style="display:flex;align-items:center;gap:10px;">
            <span style="font-size:1.8rem;line-height:1;">{{ item.icon }}</span>
            <div>
              <div style="font-weight:700;font-size:0.95rem;color:#f1f5f9;">{{ item.label }}</div>
              <div style="font-size:0.72rem;color:var(--color-text-muted);margin-top:2px;">{{ item.description }}</div>
            </div>
          </div>
          <span [style.background]="item.configured ? 'rgba(16,185,129,0.15)' : 'rgba(100,116,139,0.15)'"
            [style.color]="item.configured ? '#10b981' : '#64748b'"
            style="font-size:0.68rem;font-weight:700;padding:3px 8px;border-radius:10px;white-space:nowrap;flex-shrink:0;">
            {{ item.configured ? '✓ Active' : '○ Not set' }}
          </span>
        </div>

        <div *ngIf="item.webhookPath" style="background:#0b0f19;border-radius:6px;padding:8px 12px;margin-bottom:10px;">
          <div style="font-size:0.68rem;color:var(--color-text-muted);margin-bottom:2px;">Webhook URL</div>
          <code style="font-size:0.73rem;color:#60a5fa;word-break:break-all;">{{ platformUrl }}{{ item.webhookPath }}</code>
        </div>

        <div style="font-size:0.72rem;color:var(--color-text-muted);margin-bottom:10px;">
          <strong style="color:#94a3b8;">Required env vars: </strong>
          <span *ngFor="let v of item.envVars; let last = last">
            <code style="background:rgba(255,255,255,0.05);padding:1px 5px;border-radius:3px;color:#a78bfa;">{{ v }}</code>{{ !last ? ' ' : '' }}
          </span>
        </div>

        <div style="display:flex;gap:8px;">
          <a [href]="item.docsUrl" target="_blank" class="btn btn-sm" style="font-size:0.73rem;">Docs ↗</a>
          <a routerLink="/settings" class="btn btn-sm" style="font-size:0.73rem;">Configure →</a>
        </div>
      </div>
    </div>

    <!-- Bootstrap phase 2 reminder -->
    <div class="card" style="margin-top:20px;padding:20px;background:rgba(99,102,241,0.05);border-color:rgba(99,102,241,0.2);">
      <h2 style="margin:0 0 8px;border:0;padding:0;font-size:0.95rem;color:#818cf8;">🔧 Bootstrap Phase 2 — Integrations Menu</h2>
      <p style="color:var(--color-text-secondary);font-size:0.82rem;margin:0 0 12px 0;">When you run the bootstrap script, Phase 2 displays an interactive menu to configure each integration. The script accepts or skips each one, then writes all tokens to <code style="background:rgba(255,255,255,0.05);padding:1px 5px;border-radius:3px;">/etc/platform/.env</code> and injects them into the Kubernetes secret automatically.</p>
      <pre style="background:#0b0f19;border-radius:8px;padding:14px;font-size:0.75rem;color:#94a3b8;margin:0;overflow-x:auto;">── GitHub Integration ──
▶ Configure GitHub integration? [y/n, default: y]: y
▶ GitHub Personal Access Token: ghp_xxxx...
▶ GitHub Organization: my-org
✔ GitHub configured (webhook: https://platform.mycompany.com/api/webhooks/github)

── ClickUp Integration ──
▶ Configure ClickUp integration? [y/n, default: y]: y
▶ ClickUp API Token: pk_xxxx...
▶ ClickUp Team ID: 1234567
✔ ClickUp configured

── SMTP / Email Notifications ──
▶ Configure SMTP? [y/n, default: y]: y
  Provider options: 1) Custom SMTP  2) AWS SES  3) SendGrid  4) Mailgun
▶ Choose provider [1-4]: 3
▶ SendGrid API Key: SG.xxxx...
✔ SMTP configured</pre>
    </div>
  </div>

  <!-- ─── STATUS TAB ──────────────────────────────────────────────────────── -->
  <div *ngIf="tab === 'status'">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
      <h2 style="margin:0;border:0;padding:0;font-size:1.05rem;">💚 Infrastructure Health</h2>
      <button class="btn btn-sm" (click)="loadStatus()" [disabled]="loadingStatus">
        {{ loadingStatus ? 'Refreshing...' : '🔄 Refresh' }}
      </button>
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px;">
      <div *ngFor="let s of statusServices" class="card" style="padding:16px;margin:0;"
        [style.border-color]="s.status === 'running' ? 'rgba(16,185,129,0.3)' : s.status === 'degraded' ? 'rgba(245,158,11,0.3)' : 'rgba(239,68,68,0.3)'">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div>
            <div style="font-weight:700;font-size:0.88rem;color:#f1f5f9;">{{ s.label }}</div>
            <div style="font-size:0.72rem;color:var(--color-text-muted);margin-top:2px;">{{ s.detail || s.namespace }}</div>
          </div>
          <div style="text-align:right;">
            <div [style.color]="s.status === 'running' ? '#10b981' : s.status === 'degraded' ? '#f59e0b' : '#ef4444'"
              style="font-size:1.2rem;font-weight:900;">
              {{ s.status === 'running' ? '●' : s.status === 'degraded' ? '◑' : '○' }}
            </div>
            <div style="font-size:0.65rem;font-weight:700;text-transform:uppercase;"
              [style.color]="s.status === 'running' ? '#10b981' : s.status === 'degraded' ? '#f59e0b' : '#ef4444'">
              {{ s.status }}
            </div>
          </div>
        </div>
        <div *ngIf="s.pods" style="margin-top:8px;">
          <div style="font-size:0.72rem;color:var(--color-text-muted);">{{ s.pods }} pods running</div>
        </div>
      </div>
    </div>

    <div *ngIf="statusServices.length === 0 && !loadingStatus" style="text-align:center;padding:60px 20px;color:var(--color-text-muted);">
      Click Refresh to check infrastructure health.
    </div>
  </div>

  <!-- ─── SCRIPT TAB ──────────────────────────────────────────────────────── -->
  <div *ngIf="tab === 'script'">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <h2 style="margin:0;border:0;padding:0;font-size:1.05rem;">📜 bootstrap.sh — Full Script</h2>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-sm" (click)="downloadScript()">⬇️ Download</button>
        <button class="btn btn-sm" (click)="copyScript()">{{ scriptCopied ? '✓ Copied' : '📋 Copy' }}</button>
      </div>
    </div>
    <p style="color:var(--color-text-secondary);font-size:0.82rem;margin:0 0 16px 0;">
      The script is fully self-contained. It tracks completed steps in <code style="background:rgba(255,255,255,0.05);padding:1px 5px;border-radius:3px;">/etc/platform/.bootstrap_state</code>
      and is safe to re-run — completed phases are skipped automatically.
    </p>

    <!-- Key options -->
    <div class="card" style="padding:20px;margin-bottom:16px;background:rgba(15,23,42,0.6);">
      <h3 style="margin:0 0 12px;border:0;padding:0;font-size:0.9rem;color:#94a3b8;">Environment Variables (options)</h3>
      <div style="display:grid;grid-template-columns:auto 1fr;gap:6px 20px;font-size:0.8rem;">
        <code style="color:#a78bfa;">NON_INTERACTIVE=true</code><span style="color:var(--color-text-secondary);">Skip all prompts (CI/CD mode), use .env file</span>
        <code style="color:#a78bfa;">SKIP_K8S=true</code><span style="color:var(--color-text-secondary);">Use existing Kubernetes cluster</span>
        <code style="color:#a78bfa;">PLATFORM_DOMAIN=platform.dev</code><span style="color:var(--color-text-secondary);">Pre-fill domain (skips prompt)</span>
        <code style="color:#a78bfa;">PLATFORM_IMAGE_TAG=v2.1.0</code><span style="color:var(--color-text-secondary);">Specific image version to deploy</span>
        <code style="color:#a78bfa;">PLATFORM_REPO_URL=ghcr.io/…</code><span style="color:var(--color-text-secondary);">Container registry URL</span>
      </div>
    </div>

    <pre style="background:#0b0f19;border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:20px;font-size:0.75rem;color:#94a3b8;overflow-x:auto;max-height:600px;line-height:1.6;">{{ scriptContent }}</pre>
  </div>
</div>
  `
})
export class BootstrapComponent implements OnInit {
  tab = 'start';
  copied = false;
  scriptCopied = false;
  loadingStatus = false;
  statusServices: any[] = [];
  platformUrl = window.location.origin.replace(':4200', ':3000');

  scriptContent = `#!/usr/bin/env bash
# Platform — Full Server Bootstrap v2.0.0
# Run: sudo ./bootstrap.sh
# Docs: https://github.com/your-org/platform/blob/main/platform-bootstrap/README.md
#
# This script installs: Docker, k3s, Helm, ingress-nginx, cert-manager,
# PostgreSQL, MongoDB, Redis, MinIO, ArgoCD, Grafana+Prometheus+Loki,
# Portainer, Infisical, and finally Platform itself.
# It also walks you through configuring GitHub, GitLab, ClickUp, and SMTP.
#
# Re-run safely — completed steps are tracked in /etc/platform/.bootstrap_state

curl -fsSL https://raw.githubusercontent.com/your-org/platform/main/platform-bootstrap/bootstrap.sh | sudo bash`;

  installCmd = `curl -fsSL https://raw.githubusercontent.com/your-org/platform/main/platform-bootstrap/bootstrap.sh -o bootstrap.sh
chmod +x bootstrap.sh
sudo ./bootstrap.sh`;

  phases = [
    { phase: 0,  icon: '📦', name: 'Prerequisites',        desc: 'curl, git, jq, openssl, postgresql-client' },
    { phase: 1,  icon: '⚙️', name: 'Configuration',        desc: 'Interactive domain, email, admin credentials setup' },
    { phase: 2,  icon: '🔗', name: 'Integrations Menu',    desc: 'GitHub, GitLab, ClickUp, SMTP, S3 — all prompted interactively' },
    { phase: 3,  icon: '🐳', name: 'Docker CE',            desc: 'Container runtime installed via get.docker.com' },
    { phase: 4,  icon: '☸️', name: 'Kubernetes (k3s)',     desc: 'Lightweight K8s — no cloud required, runs on bare metal' },
    { phase: 5,  icon: '⛵', name: 'Helm',                 desc: 'Kubernetes package manager + all chart repos pre-added' },
    { phase: 6,  icon: '🗂️', name: 'Namespaces',           desc: 'platform, databases, monitoring, storage, argocd...' },
    { phase: 7,  icon: '🌐', name: 'ingress-nginx',        desc: 'HTTP/S routing with wildcard subdomain support' },
    { phase: 8,  icon: '🔒', name: 'cert-manager',         desc: 'Automatic HTTPS via Let\'s Encrypt (staging + prod issuers)' },
    { phase: 9,  icon: '🗄️', name: 'PostgreSQL + Mongo + Redis', desc: 'All databases via Bitnami Helm charts with auto-passwords' },
    { phase: 10, icon: '📦', name: 'MinIO',               desc: 'S3-compatible object storage for database backups & artifacts' },
    { phase: 11, icon: '🐙', name: 'ArgoCD',              desc: 'GitOps CD — auto-sync from Git on every push' },
    { phase: 12, icon: '📊', name: 'Grafana + Prometheus + Loki', desc: 'Full observability stack with Loki datasource auto-configured' },
    { phase: 13, icon: '🐳', name: 'Portainer',           desc: 'Visual container management UI with ingress' },
    { phase: 14, icon: '🔐', name: 'Infisical',           desc: 'Self-hosted secret management, synced to project environments' },
    { phase: 15, icon: '🚀', name: 'Platform',       desc: 'API + Portal deployed with all env vars pre-wired from config' },
    { phase: 16, icon: '♾️', name: 'ArgoCD GitOps App',   desc: 'Auto-sync application created pointing at your Git repo' },
    { phase: 17, icon: '🌱', name: 'First-run Seed',      desc: 'Admin user created + MinIO registered as default backup storage' },
    { phase: 18, icon: '💚', name: 'Health Check',        desc: 'Verifies all pods are running and prints final summary' },
  ];

  integrations: IntegrationItem[] = [
    {
      key: 'github',
      label: 'GitHub',
      icon: '🐙',
      description: 'Auto-deploy on push, webhook-driven PR previews, package registry',
      docsUrl: 'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens',
      webhookPath: '/api/webhooks/github',
      configured: false,
      envVars: ['GITHUB_TOKEN', 'GITHUB_ORG'],
    },
    {
      key: 'gitlab',
      label: 'GitLab',
      icon: '🦊',
      description: 'GitLab CI/CD pipeline triggers, MR preview environments',
      docsUrl: 'https://docs.gitlab.com/ee/user/profile/personal_access_tokens.html',
      webhookPath: '/api/webhooks/gitlab',
      configured: false,
      envVars: ['GITLAB_TOKEN', 'GITLAB_URL'],
    },
    {
      key: 'clickup',
      label: 'ClickUp',
      icon: '📋',
      description: 'Link deployments to tasks, auto-create tasks from bug reports',
      docsUrl: 'https://clickup.com/api/developer-portal/authentication',
      configured: false,
      envVars: ['CLICKUP_API_TOKEN', 'CLICKUP_TEAM_ID'],
    },
    {
      key: 'smtp',
      label: 'SMTP / Email',
      icon: '📧',
      description: 'Deployment success/failure emails, backup notifications',
      docsUrl: 'https://nodemailer.com/smtp/',
      configured: false,
      envVars: ['SMTP_PROVIDER', 'SMTP_FROM_EMAIL'],
    },
    {
      key: 'argocd',
      label: 'ArgoCD',
      icon: '🐙',
      description: 'GitOps continuous delivery, auto-sync from Git on every push',
      docsUrl: 'https://argo-cd.readthedocs.io',
      configured: false,
      envVars: ['ARGOCD_URL', 'ARGOCD_TOKEN'],
    },
    {
      key: 'infisical',
      label: 'Infisical',
      icon: '🔐',
      description: 'Secrets synced to project environments on deploy',
      docsUrl: 'https://infisical.com/docs',
      configured: false,
      envVars: ['INFISICAL_URL', 'INFISICAL_TOKEN'],
    },
    {
      key: 'minio',
      label: 'MinIO / S3',
      icon: '📦',
      description: 'Database backup storage target — MinIO bundled, or bring your own S3',
      docsUrl: 'https://min.io/docs/minio/kubernetes/upstream',
      configured: false,
      envVars: ['MINIO_ENDPOINT', 'MINIO_ACCESS_KEY'],
    },
    {
      key: 'grafana',
      label: 'Grafana',
      icon: '📊',
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
        { label: 'Infisical',     namespace: 'infisical',      status: services['infisical']     || 'unknown', detail: 'Secret management' },
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

  copyScript() {
    navigator.clipboard.writeText(this.scriptContent).catch(() => {});
    this.scriptCopied = true;
    setTimeout(() => this.scriptCopied = false, 2000);
  }

  downloadScript() {
    const blob = new Blob([this.scriptContent], { type: 'text/x-sh' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'bootstrap.sh'; a.click();
    URL.revokeObjectURL(url);
  }
}
