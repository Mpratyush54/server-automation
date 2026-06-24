import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../services/api.service';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.css'
})
export class DashboardComponent implements OnInit {
  stats = { projects: 0, deployments: 0, services: 0, storage: '0 B' };
  recentDeployments: any[] = [];
  systemHealth: any[] = [];

  constructor(private api: ApiService) {}

  async ngOnInit() {
    try {
      const projects = await firstValueFrom(this.api.getProjects()) as any[];
      this.stats.projects = projects.length;
      this.recentDeployments = projects
        .flatMap((p: any) => (p.deployments || []).map((d: any) => ({ ...d, projectName: p.name })))
        .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 10);
      this.stats.deployments = this.recentDeployments.filter((d: any) => d.status === 'active').length;
    } catch { this.stats.projects = 0; }

    try {
      const status = await firstValueFrom(this.api.getBootstrapStatus()) as any;
      this.systemHealth = Object.entries(status.services || {}).map(([name, s]) => ({ name, status: s }));
      this.stats.services = this.systemHealth.filter(s => s.status === 'running').length;
    } catch { this.stats.services = 0; }
  }
}
