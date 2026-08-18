import { Component, Input, Output, EventEmitter, OnDestroy, OnInit, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterModule } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../services/auth.service';
import { ApiService } from '../../services/api.service';

@Component({
  selector: 'app-header',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './header.component.html',
  styleUrl: './header.component.css'
})
export class HeaderComponent implements OnInit, OnDestroy {
  @Input() title = 'Dashboard';
  @Input() isSidebarCollapsed = false;
  @Output() toggleSidebar = new EventEmitter<void>();

  currentUser: any = null;
  notifications: any[] = [];
  unreadCount = 0;
  inboxOpen = false;
  private poll: ReturnType<typeof setInterval> | null = null;

  constructor(private auth: AuthService, private api: ApiService, private router: Router) {}

  ngOnInit() {
    this.currentUser = this.auth.getUser();
    this.refreshProfile();
    this.loadNotifications();
    this.poll = setInterval(() => this.loadNotifications(), 30000);
  }

  ngOnDestroy() {
    if (this.poll) clearInterval(this.poll);
  }

  @HostListener('document:click')
  closeInbox() {
    this.inboxOpen = false;
  }

  get initials(): string {
    const n = this.currentUser?.name || this.currentUser?.email || '?';
    const parts = String(n).trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return String(n).slice(0, 2).toUpperCase();
  }

  toggleInbox(event: Event) {
    event.stopPropagation();
    this.inboxOpen = !this.inboxOpen;
    if (this.inboxOpen) this.loadNotifications();
  }

  async refreshProfile() {
    try {
      const me = await firstValueFrom(this.api.getMe());
      this.currentUser = me;
      this.auth.setUser({
        id: me.id,
        name: me.name,
        email: me.email,
        role: me.role,
        avatarUrl: me.avatarUrl,
      });
    } catch {
      this.currentUser = this.auth.getUser();
    }
  }

  async loadNotifications() {
    try {
      const res = await firstValueFrom(this.api.getNotifications());
      this.notifications = res.items || [];
      this.unreadCount = res.unreadCount || 0;
    } catch {
      this.notifications = [];
      this.unreadCount = 0;
    }
  }

  async openNotification(n: any, event: Event) {
    event.stopPropagation();
    if (!n.readAt) {
      try { await firstValueFrom(this.api.markNotificationRead(n.id)); } catch {}
    }
    this.inboxOpen = false;
    await this.loadNotifications();
    if (n.link) this.router.navigateByUrl(n.link);
  }

  async markAllRead(event: Event) {
    event.stopPropagation();
    try { await firstValueFrom(this.api.markAllNotificationsRead()); } catch {}
    await this.loadNotifications();
  }
}
