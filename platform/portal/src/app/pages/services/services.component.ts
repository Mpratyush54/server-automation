import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../services/api.service';
import { ToastService, errorText } from '../../shared/feedback/feedback.service';

@Component({
  selector: 'app-services',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './services.component.html',
  styleUrl: './services.component.css'
})
export class ServicesComponent implements OnInit {
  registrations: any[] = [];
  reg = { serviceName: '', projectName: 'development', environmentName: 'development', version: '1.0.0', branch: 'main', dbTypes: '' };

  private toast = inject(ToastService);

  constructor(private api: ApiService) {}

  async ngOnInit() {
    try {
      const projects = await firstValueFrom(this.api.getProjects()) as any[];
      this.registrations = projects.flatMap((p: any) => p.registrations || []);
    } catch { this.registrations = []; }
  }

  async register() {
    try {
      await firstValueFrom(this.api.registerService({
        ...this.reg,
        dbTypes: this.reg.dbTypes.split(',').map(s => s.trim()).filter(Boolean),
      }));
      this.reg = { serviceName: '', projectName: 'development', environmentName: 'development', version: '1.0.0', branch: 'main', dbTypes: '' };
      this.toast.ok('Service registered');
    } catch (err: any) { this.toast.error('Service was not registered: ' + errorText(err)); }
  }
}
