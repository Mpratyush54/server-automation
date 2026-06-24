import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../services/api.service';

@Component({
  selector: 'app-storage',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './storage.component.html',
  styleUrl: './storage.component.css'
})
export class StorageComponent {
  projectId = '';
  analytics: any = null;
  files: any[] = [];

  constructor(private api: ApiService) {}

  async loadAnalytics() {
    try {
      const [analytics, files] = await Promise.all([
        firstValueFrom(this.api.getStorageAnalytics(this.projectId)),
        firstValueFrom(this.api.getProjectFiles(this.projectId)),
      ]);
      this.analytics = analytics;
      this.files = files;
    } catch {}
  }
}
