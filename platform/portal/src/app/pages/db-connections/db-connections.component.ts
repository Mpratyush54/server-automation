import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../services/api.service';

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

  constructor(private api: ApiService) {}

  async ngOnInit() {
    try { this.connections = await firstValueFrom(this.api.getDbConnections()); } catch { this.connections = []; }
  }

  async create() {
    try {
      await firstValueFrom(this.api.createDbConnection(this.newConn));
      this.connections = await firstValueFrom(this.api.getDbConnections());
    } catch (err: any) { alert('Failed: ' + (err.error?.error || err.message)); }
  }

  async delete(id: string) {
    if (!confirm('Delete this connection?')) return;
    try { await firstValueFrom(this.api.deleteDbConnection(id)); this.connections = this.connections.filter(c => c.id !== id); } catch {}
  }
}
