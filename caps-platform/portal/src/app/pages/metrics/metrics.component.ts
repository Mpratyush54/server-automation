import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../services/api.service';

@Component({
  selector: 'app-metrics',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './metrics.component.html',
  styleUrl: './metrics.component.css'
})
export class MetricsComponent {
  query = { projectId: '', serviceName: '' };
  aggregated: any[] = [];
  loading = false;

  constructor(private api: ApiService) {}

  async load() {
    this.loading = true;
    try {
      this.aggregated = await firstValueFrom(this.api.getAggregatedMetrics(this.query.projectId));
    } catch { this.aggregated = []; }
    this.loading = false;
  }
}
