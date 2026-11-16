import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../services/api.service';
import { ToastService, DialogService, errorText } from '../../shared/feedback/feedback.service';

@Component({
  selector: 'app-db-connections',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './db-connections.component.html',
  styleUrl: './db-connections.component.css'
})
export class DbConnectionsComponent implements OnInit {
  connections: any[] = [];
  newConn = { projectId: '', dbType: 'postgres', poolSize: 10 };

  private toast = inject(ToastService);
  private dialog = inject(DialogService);

  constructor(private api: ApiService) {}

  async ngOnInit() {
    try { this.connections = await firstValueFrom(this.api.getDbConnections()); } catch { this.connections = []; }
  }

  async create() {
    try {
      await firstValueFrom(this.api.createDbConnection(this.newConn));
      this.connections = await firstValueFrom(this.api.getDbConnections());
      this.toast.ok('Connection added');
    } catch (err: any) { this.toast.error('Connection was not added: ' + errorText(err)); }
  }

  async delete(id: string) {
    const ok = await this.dialog.confirm({
      title: 'Delete this database connection?',
      message: 'The saved connection details are removed. The database itself is not touched.',
      confirmLabel: 'Delete connection',
      danger: true,
    });
    if (!ok) return;
    try { await firstValueFrom(this.api.deleteDbConnection(id)); this.connections = this.connections.filter(c => c.id !== id); } catch {}
  }
}
