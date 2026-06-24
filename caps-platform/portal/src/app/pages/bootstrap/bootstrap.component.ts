import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../services/api.service';

@Component({
  selector: 'app-bootstrap',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './bootstrap.component.html',
  styleUrl: './bootstrap.component.css'
})
export class BootstrapComponent {
  initData = { hostname: '', components: '' };
  result: any = null;
  statusServices: any[] = [];
  loading = false;

  constructor(private api: ApiService) {}

  async init() {
    this.loading = true;
    try {
      this.result = await firstValueFrom(this.api.bootstrapInit({
        hostname: this.initData.hostname,
        components: this.initData.components ? this.initData.components.split(',').map((s: string) => s.trim()).filter(Boolean) : undefined,
      }));
    } catch {}
    this.loading = false;
  }

  async checkStatus() {
    try {
      const s = await firstValueFrom(this.api.getBootstrapStatus()) as any;
      this.statusServices = Object.entries(s.services || {}).map(([name, status]) => ({ name, status }));
    } catch {}
  }
}
