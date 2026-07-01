import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../services/api.service';

@Component({
  selector: 'app-deployments',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './deployments.component.html',
  styleUrl: './deployments.component.css'
})
export class DeploymentsComponent implements OnInit {
  deployments: any[] = [];
  deployDto = { projectId: '', version: '', branch: 'main' };
  rollbackDto = { projectId: '', deploymentId: '' };

  constructor(private api: ApiService) {}

  async ngOnInit() {
    try {
      const projects = await firstValueFrom(this.api.getProjects()) as any[];
      this.deployments = projects.flatMap((p: any) => (p.deployments || []).map((d: any) => ({ ...d, projectName: p.name })));
    } catch { this.deployments = []; }
  }

  async deploy() {
    try {
      const d = await firstValueFrom(this.api.deploy(this.deployDto));
      this.deployments.unshift(d);
      this.deployDto = { projectId: '', version: '', branch: 'main' };
    } catch (err: any) { alert('Deploy failed: ' + (err.error?.error || err.message)); }
  }

  async rollback() {
    try {
      await firstValueFrom(this.api.rollback(this.rollbackDto));
      alert('Rollback initiated');
    } catch (err: any) { alert('Rollback failed: ' + (err.error?.error || err.message)); }
  }

  async restart(id: string) {
    try {
      await firstValueFrom(this.api.restartDeployment(id));
      alert('Restart initiated');
    } catch {}
  }
}
