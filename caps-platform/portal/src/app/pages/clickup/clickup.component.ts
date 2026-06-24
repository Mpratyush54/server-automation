import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { HttpClient } from '@angular/common/http';

@Component({
  selector: 'app-clickup',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './clickup.component.html',
  styleUrl: './clickup.component.css'
})
export class ClickupComponent implements OnInit {
  status: any = null;
  linkedTasks: any[] = [];
  isDevOps = false;

  // Mock task simulator payload
  simulatedTask = {
    task_id: 'CU-842',
    status: 'In Review'
  };

  constructor(private api: ApiService, private auth: AuthService, private http: HttpClient) {}

  async ngOnInit() {
    this.isDevOps = this.auth.isDevOps();
    await this.loadStatus();
    await this.loadLinkedTasks();
  }

  async loadStatus() {
    try {
      this.status = await firstValueFrom(this.api.getBootstrapStatus()); // fallback or dummy
    } catch {
      this.status = { services: { clickup: 'active' } };
    }
  }

  async loadLinkedTasks() {
    try {
      const projects = await firstValueFrom(this.api.getProjects()) as any[];
      const tempLinks: any[] = [];

      for (const p of projects) {
        const deployments = p.deployments || [];
        for (const d of deployments) {
          if (d.clickupTaskId) {
            tempLinks.push({
              taskId: d.clickupTaskId,
              projectName: p.name,
              branch: d.branch,
              status: d.status,
              version: d.version,
              deployedAt: new Date(d.deployedAt || d.createdAt)
            });
          }
        }
      }

      this.linkedTasks = tempLinks.sort((a, b) => b.deployedAt.getTime() - a.deployedAt.getTime());
    } catch (err: any) {
      console.error('Failed to load ClickUp links:', err.message);
    }
  }

  async triggerWebhook() {
    try {
      // Stripping "CU-" if added in simulator input
      const taskId = this.simulatedTask.task_id.replace(/^CU-/i, '');
      const payload = {
        task_id: taskId,
        status: this.simulatedTask.status
      };
      
      const res = await firstValueFrom(this.http.post<any>('/api/integrations/clickup/webhook', payload));
      alert(res.message || 'Webhook processed successfully!');
      await this.loadLinkedTasks();
    } catch (err: any) {
      alert('Failed to trigger simulated webhook: ' + (err.error?.error || err.message));
    }
  }
}
