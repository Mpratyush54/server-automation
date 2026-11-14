import { Component, Input, Output, EventEmitter, OnDestroy, OnInit, HostListener, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterModule } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../services/auth.service';
import { ApiService } from '../../services/api.service';
import { SearchService } from '../../services/search.service';
import { SearchPaletteComponent } from '../../shared/search/search-palette.component';

@Component({
  selector: 'app-header',
  standalone: true,
  imports: [CommonModule, RouterModule, SearchPaletteComponent],
  templateUrl: './header.component.html',
  styleUrl: './header.component.css'
})
export class HeaderComponent implements OnInit, OnDestroy {
  @Input() title = 'Dashboard';
  @Input() isSidebarCollapsed = false;
  /** Below md the header shows a menu button that opens the nav drawer. */
  @Input() isMobile = false;
  @Input() mobileNavOpen = false;
  @Output() toggleSidebar = new EventEmitter<void>();

  currentUser: any = null;
  notifications: any[] = [];
  unreadCount = 0;
  inboxOpen = false;
  private poll: ReturnType<typeof setInterval> | null = null;
  readonly search = inject(SearchService);
  /** Shortcut hint shown in the search field. */
  readonly shortcutHint = isApplePlatform() ? '⌘K' : 'Ctrl K';

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

  /** Ctrl+K / Cmd+K anywhere, or "/" when not typing in a field, opens the search palette. */
  @HostListener('document:keydown', ['$event'])
  onGlobalKeydown(event: KeyboardEvent) {
    const key = (event.key || '').toLowerCase();
    if (key === 'k' && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
      event.preventDefault();
      if (this.search.isOpen()) this.search.close();
      else this.openSearch();
      return;
    }
    if (key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !this.search.isOpen() && !isTypingTarget(event.target)) {
      event.preventDefault();
      this.openSearch();
    }
  }

  openSearch() {
    this.inboxOpen = false;
    this.search.open();
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

function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const p = (navigator as any).userAgentData?.platform || navigator.platform || navigator.userAgent || '';
  return /mac|iphone|ipad|ipod/i.test(p);
}

/** True when the key press belongs to a text field, select or editable region. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return false;
  if (el.isContentEditable) return true;
  return !!el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
}
