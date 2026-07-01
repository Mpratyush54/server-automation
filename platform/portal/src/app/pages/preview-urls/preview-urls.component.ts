import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../services/api.service';

@Component({
  selector: 'app-preview-urls',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './preview-urls.component.html',
  styleUrl: './preview-urls.component.css'
})
export class PreviewUrlsComponent implements OnInit, OnDestroy {
  previews: any[] = [];
  timerId: any;

  constructor(private api: ApiService) {}

  async ngOnInit() {
    await this.loadPreviews();
    // Refresh countdowns every 30 seconds
    this.timerId = setInterval(() => {
      this.updateRemainingTimes();
    }, 30000);
  }

  ngOnDestroy() {
    if (this.timerId) clearInterval(this.timerId);
  }

  async loadPreviews() {
    try {
      const projects = await firstValueFrom(this.api.getProjects()) as any[];
      const tempPreviews: any[] = [];

      for (const p of projects) {
        const deployments = p.deployments || [];
        const envs = p.environments || [];
        
        // Find deployments that are deployed and have a preview URL or map to a preview environment
        const previewDeployments = deployments.filter((d: any) => {
          const env = envs.find((e: any) => e.id === d.environmentId);
          return d.status === 'deployed' && (d.previewUrl || (env && env.name === 'preview'));
        });

        for (const d of previewDeployments) {
          const env = envs.find((e: any) => e.id === d.environmentId);
          const finalUrl = d.previewUrl || (env ? `https://${env.domain}` : '');
          
          tempPreviews.push({
            id: d.id,
            projectName: p.name,
            branch: d.branch,
            version: d.version,
            commitSha: d.commitSha,
            previewUrl: finalUrl,
            clickupTaskId: d.clickupTaskId,
            deployedAt: new Date(d.deployedAt || d.createdAt),
            remainingTime: ''
          });
        }
      }

      this.previews = tempPreviews.sort((a, b) => b.deployedAt.getTime() - a.deployedAt.getTime());
      this.updateRemainingTimes();
    } catch (err: any) {
      console.error('Failed to load preview URLs:', err.message);
    }
  }

  updateRemainingTimes() {
    const TTL_HOURS = 72;
    const now = new Date();

    for (const p of this.previews) {
      const expiry = new Date(p.deployedAt.getTime() + TTL_HOURS * 60 * 60 * 1000);
      const diffMs = expiry.getTime() - now.getTime();

      if (diffMs <= 0) {
        p.remainingTime = 'Expired';
      } else {
        const hours = Math.floor(diffMs / (3600 * 1000));
        const mins = Math.floor((diffMs % (3600 * 1000)) / (60 * 1000));
        p.remainingTime = `${hours}h ${mins}m`;
      }
    }
  }

  async terminate(id: string) {
    if (!confirm('Are you sure you want to terminate this preview environment? This action is immediate.')) return;
    try {
      await firstValueFrom(this.api.terminateDeployment(id));
      await this.loadPreviews();
    } catch (err: any) {
      alert('Failed to terminate preview environment: ' + (err.error?.error || err.message));
    }
  }
}
