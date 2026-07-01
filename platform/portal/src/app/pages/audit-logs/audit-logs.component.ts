import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../services/api.service';
import { HttpClient } from '@angular/common/http';

@Component({
  selector: 'app-audit-logs',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './audit-logs.component.html',
  styleUrl: './audit-logs.component.css'
})
export class AuditLogsComponent implements OnInit {
  logs: any[] = [];
  users: any[] = [];

  constructor(private http: HttpClient, private api: ApiService) {}

  async ngOnInit() {
    await this.loadUsers();
    await this.loadAuditLogs();
  }

  async loadUsers() {
    try {
      this.users = await firstValueFrom(this.api.getUsers());
    } catch {
      this.users = [];
    }
  }

  async loadAuditLogs() {
    try {
      const raw = await firstValueFrom(this.http.get<any[]>('/api/audit-logs'));
      this.logs = raw.map(log => {
        const u = this.users.find(usr => usr.id === log.userId);
        return {
          ...log,
          userName: u ? u.name : 'Unknown User',
          userEmail: u ? u.email : log.userId,
          metadataStr: log.metadata ? JSON.stringify(log.metadata, null, 2) : ''
        };
      });
    } catch (err: any) {
      console.error('Failed to load audit logs:', err.message);
    }
  }
}
