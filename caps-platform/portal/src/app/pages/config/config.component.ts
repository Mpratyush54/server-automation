import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../services/api.service';

@Component({
  selector: 'app-config',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './config.component.html',
  styleUrl: './config.component.css'
})
export class ConfigComponent {
  projectId = '';
  configEntries: { key: string; value: any; isSecret: boolean }[] = [];
  newConfig = { key: '', value: '', isSecret: false };
  loading = false;

  constructor(private api: ApiService) {}

  async load() {
    if (!this.projectId) return;
    this.loading = true;
    try {
      const data = await firstValueFrom(this.api.getConfig(this.projectId)) as Record<string, any>;
      this.configEntries = Object.entries(data).map(([key, value]) => ({
        key,
        value,
        isSecret: value === '***',
      }));
    } catch { this.configEntries = []; }
    this.loading = false;
  }

  async setConfig() {
    if (!this.projectId || !this.newConfig.key) return;
    try {
      await firstValueFrom(this.api.setConfig({
        projectId: this.projectId,
        key: this.newConfig.key,
        value: this.newConfig.value,
        isSecret: this.newConfig.isSecret,
      }));
      await this.load();
      this.newConfig = { key: '', value: '', isSecret: false };
    } catch (err: any) { alert('Failed to set config: ' + (err.error?.error || err.message)); }
  }
}
