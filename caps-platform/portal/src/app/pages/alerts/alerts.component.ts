import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../services/api.service';

@Component({
  selector: 'app-alerts',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './alerts.component.html',
  styleUrl: './alerts.component.css'
})
export class AlertsComponent implements OnInit {
  alerts: any[] = [];
  newAlert = { projectId: '', metric: 'cpu', operator: '>', threshold: 80 };
  loading = false;

  constructor(private api: ApiService) {}

  async ngOnInit() {
    this.loading = true;
    try { this.alerts = await firstValueFrom(this.api.getAlerts()); } catch { this.alerts = []; }
    this.loading = false;
  }

  async createAlert() {
    try {
      await firstValueFrom(this.api.createAlert({
        projectId: this.newAlert.projectId,
        config: { metric: this.newAlert.metric, operator: this.newAlert.operator, threshold: Number(this.newAlert.threshold) },
      }));
      this.alerts = await firstValueFrom(this.api.getAlerts());
      this.newAlert = { projectId: '', metric: 'cpu', operator: '>', threshold: 80 };
    } catch (err: any) { alert('Failed: ' + (err.error?.error || err.message)); }
  }

  async deleteAlert(id: string) {
    if (!confirm('Delete this alert rule?')) return;
    try { await firstValueFrom(this.api.deleteAlert(id)); this.alerts = this.alerts.filter(a => a.id !== id); } catch {}
  }
}
