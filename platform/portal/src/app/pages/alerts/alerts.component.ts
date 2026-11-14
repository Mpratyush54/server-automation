import { Component, OnInit, inject } from '@angular/core';

import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../services/api.service';
import { ToastService, DialogService, errorText } from '../../shared/feedback/feedback.service';

@Component({
  selector: 'app-alerts',
  standalone: true,
  imports: [FormsModule, RouterLink],
  templateUrl: './alerts.component.html',
  styleUrl: './alerts.component.css'
})
export class AlertsComponent implements OnInit {
  alerts: any[] = [];
  newAlert = { projectId: '', metric: 'cpu', operator: '>', threshold: 80 };
  loading = false;

  private toast = inject(ToastService);
  private dialog = inject(DialogService);

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
      this.toast.ok('Alert rule created');
    } catch (err: any) { this.toast.error('Alert rule was not created: ' + errorText(err)); }
  }

  async deleteAlert(id: string) {
    const ok = await this.dialog.confirm({
      title: 'Delete this alert rule?',
      message: 'The rule stops checking this metric right away. This cannot be undone.',
      confirmLabel: 'Delete rule',
      danger: true,
    });
    if (!ok) return;
    try { await firstValueFrom(this.api.deleteAlert(id)); this.alerts = this.alerts.filter(a => a.id !== id); } catch {}
  }
}
