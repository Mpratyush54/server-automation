import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../services/api.service';
import { OperationProgressComponent } from '../../shared/operation-progress.component';
import { ToastService, errorText } from '../../shared/feedback/feedback.service';

@Component({
  selector: 'app-deployments',
  standalone: true,
  imports: [CommonModule, FormsModule, OperationProgressComponent],
  templateUrl: './deployments.component.html',
  styleUrl: './deployments.component.css'
})
export class DeploymentsComponent implements OnInit {
  deployments: any[] = [];
  deployDto = { projectId: '', version: '', branch: 'main' };
  rollbackDto = { projectId: '', deploymentId: '' };
  /** Progress of the last deploy started from this page. */
  lastOperationId: string | null = null;

  private toast = inject(ToastService);

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
      this.lastOperationId = (d as any)?.operationId || null;
      this.deployDto = { projectId: '', version: '', branch: 'main' };
      this.toast.ok('Deployment started');
    } catch (err: any) { this.toast.error('Deployment did not start: ' + errorText(err)); }
  }

  async rollback() {
    try {
      await firstValueFrom(this.api.rollback(this.rollbackDto));
      this.toast.ok('Rollback started');
    } catch (err: any) { this.toast.error('Rollback did not start: ' + errorText(err)); }
  }

  async restart(id: string) {
    try {
      await firstValueFrom(this.api.restartDeployment(id));
      this.toast.ok('Restart started');
    } catch {}
  }
}
