import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../services/api.service';

@Component({
  selector: 'app-logs',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './logs.component.html',
  styleUrl: './logs.component.css'
})
export class LogsComponent {
  query = { projectId: '', serviceName: '', level: '', search: '' };
  logs: any[] = [];
  total = 0;
  loading = false;

  constructor(private api: ApiService) {}

  async search() {
    this.loading = true;
    try {
      const params: any = {};
      if (this.query.projectId) params.projectId = this.query.projectId;
      if (this.query.serviceName) params.serviceName = this.query.serviceName;
      if (this.query.level) params.level = this.query.level;
      if (this.query.search) params.search = this.query.search;
      const result = await firstValueFrom(this.api.searchLogs(params));
      this.logs = result.logs || [];
      this.total = result.total || 0;
    } catch { this.logs = []; this.total = 0; }
    this.loading = false;
  }
}
