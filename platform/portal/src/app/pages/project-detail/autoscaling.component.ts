import { Component, Input, OnChanges } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../services/api.service';
import { ToastService } from '../../shared/feedback/feedback.service';

@Component({
  selector: 'app-autoscaling',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './autoscaling.component.html',
  styleUrls: ['./project-section-shared.css', './autoscaling.component.css'],
})
export class AutoscalingComponent implements OnChanges {
  @Input() projectId = '';
  @Input() environmentId = '';
  @Input() preview = false;
  @Input() canEdit = false;
  settings: any = { enabled: false, minReplicas: 1, maxReplicas: 3, targetCpuPercent: 70 };
  capabilities = { rps: false, scaleToZero: false };
  workloads: any[] = [];
  namespace = '';
  loading = true;
  saving = false;
  error = '';

  constructor(private api: ApiService, private toast: ToastService) {}

  async ngOnChanges() { await this.load(); }

  async load() {
    this.loading = true;
    this.error = '';
    try { this.accept(await firstValueFrom(this.api.getEnvironmentAutoscaling(this.projectId, this.environmentId))); }
    catch (e: any) { this.error = e.error?.error || 'Autoscaling status is unavailable. Try refreshing.'; }
    finally { this.loading = false; }
  }

  private accept(result: any) {
    this.settings = { ...result.settings };
    this.capabilities = result.capabilities;
    this.workloads = result.workloads;
    this.namespace = result.namespace || '';
  }

  status(workload: any): string {
    if (!this.settings.enabled) return 'manual';
    const conditions = workload.hpa?.conditions || [];
    return conditions.some((c: any) => c.type === 'ScalingActive' && c.status === 'True') ? 'active' : 'waiting';
  }

  async save() {
    if (!this.canEdit || this.loading || this.saving) return;
    this.saving = true;
    this.error = '';
    const settings = { ...this.settings };
    for (const key of ['targetCpuPercent', 'targetMemoryPercent', 'targetRps']) if (settings[key] === '' || settings[key] == null) delete settings[key];
    try {
      this.accept(await firstValueFrom(this.api.putEnvironmentAutoscaling(this.projectId, this.environmentId, settings)));
      this.toast.ok('Autoscaling saved');
    } catch (e: any) {
      this.error = e.error?.error || 'Autoscaling was not saved. Try again.';
      this.toast.error(this.error);
    } finally { this.saving = false; }
  }
}
