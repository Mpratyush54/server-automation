import { Component, OnInit } from '@angular/core';
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
export class DashboardComponent implements OnInit {
  stats = { projects: 0, deployments: 0, services: 0, namespaces: 6, podsText: '0 / 0', podsProgress: 0 };
  recentDeployments: any[] = [];
  systemHealth: any[] = [];
  projectsList: any[] = [];
  grafanaEmbedUrl!: SafeResourceUrl;
  showIframe = true;
  iframeLoaded = false;

  constructor(private api: ApiService, private sanitizer: DomSanitizer, private auth: AuthService) {}

  async ngOnInit() {
    // Sanitize Grafana embed URL dynamically
    const domain = window.location.hostname || 'localhost';
    const grafanaHost = domain === 'localhost' ? 'localhost:3000' : `grafana.${domain}`;
    this.grafanaEmbedUrl = this.sanitizer.bypassSecurityTrustResourceUrl(
      `http://${grafanaHost}/d-solo/rYy79FwVz/kubernetes-compute-resources-cluster?orgId=1&panelId=1&theme=dark`
    );

    // 1. Fetch Projects & Deployments
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

    // 2. Compute project namespaces (scoped)
    const projectNamespaces = new Set<string>();
    const projectNames = this.projectsList.map(p => p.name.toLowerCase());
    
    this.projectsList.forEach((p: any) => {
      if (p.environments) {
        p.environments.forEach((e: any) => {
          if (e.namespace) {
            projectNamespaces.add(e.namespace.toLowerCase());
          }
        });
      }
    });

    const hasPreview = this.recentDeployments.some(d => d.environment === 'preview' || d.environmentId === 'preview');
    if (hasPreview) {
      projectNamespaces.add('preview');
    }

    this.stats.namespaces = projectNamespaces.size;

    // 3. Fetch Scoped Pods Count (Only DevOps can access)
    let runningPods = 0;
    let totalPods = 0;
    if (this.auth.isDevOps() && this.projectsList.length > 0) {
      try {
        const podsRes = await firstValueFrom(this.api.getPods());
        const pods = podsRes.pods || [];
        
        const filteredPods = pods.filter((pod: any) => {
          const podNs = pod.namespace.toLowerCase();
          const podName = pod.name.toLowerCase();
          
          if (projectNamespaces.has(podNs)) {
            if (podNs === 'preview') {
              return projectNames.some(pName => podName.includes(pName));
            }
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

    // 4. Fetch System Health Services
    try {
      const status = await firstValueFrom(this.api.getBootstrapStatus()) as any;
      this.systemHealth = Object.entries(status.services || {}).map(([name, s]) => ({ name, status: s }));
      this.stats.services = this.systemHealth.filter(s => s.status === 'running').length;
    } catch { 
      this.stats.services = 0; 
      this.systemHealth = [];
    }
  }

  onIframeLoad() {
    this.iframeLoaded = true;
  }
}
