import { Component, OnInit, Input, Output, EventEmitter, inject } from '@angular/core';
import { RouterModule } from '@angular/router';

import { AuthService } from '../../services/auth.service';
import { ThemeService } from '../../services/theme.service';

/** One sidebar entry: an in-app route or an external page (Argo CD, Grafana, Portainer, docs). */
export interface NavItem {
  label: string;
  icon: string;
  /** In-app route. */
  route?: string;
  /** Full-page link to another app served next to the portal. */
  href?: string;
  external?: boolean;
  exact?: boolean;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

/** SVG path data for the 18px stroke icons (24-unit viewBox). */
const ICONS: Record<string, string> = {
  dashboard: 'M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z',
  projects: 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z',
  observability: 'M3 3v18h18M7 15l4-4 3 3 5-6',
  errors: 'M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01',
  alerts: 'M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0',
  infrastructure: 'M2 4h20v6H2zM2 14h20v6H2zM6 7h.01M6 17h.01',
  argocd: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
  grafana: 'M3 12h4l2-6 4 12 2-6h4',
  portainer: 'M2 3h20v14H2zM8 21h8M12 17v4',
  users: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
  profile: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  docs: 'M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2zM22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z',
};

@Component({
  selector: 'app-sidebar',
  standalone: true,
  imports: [RouterModule],
  templateUrl: './sidebar.component.html',
  styleUrl: './sidebar.component.css',
})
export class SidebarComponent implements OnInit {
  @Input() isCollapsed = false;
  /** Below md the sidebar renders as an off-canvas drawer. */
  @Input() isMobile = false;
  /** Drawer open state (mobile only). */
  @Input() isOpen = false;
  @Output() toggleCollapse = new EventEmitter<void>();
  /** Emitted when a nav link is clicked so the shell can close the drawer. */
  @Output() navigate = new EventEmitter<void>();
  isDevOps = false;
  isTechLeadOrDevOps = false;
  canManageUsers = false;
  /** Portainer must use its own host — path /portainer collides with portal /api + assets. */
  portainerUrl = 'http://localhost:9000';
  groups: NavGroup[] = [];
  readonly icons = ICONS;
  readonly theme = inject(ThemeService);

  constructor(private auth: AuthService) {}

  ngOnInit() {
    this.isDevOps = this.auth.isDevOps() || this.auth.isAdmin();
    this.isTechLeadOrDevOps = this.auth.isTechLeadOrDevOps();
    this.canManageUsers = this.auth.canManageUsers();
    const host = window.location.hostname;
    if (host !== 'localhost' && host !== '127.0.0.1') {
      this.portainerUrl = `${window.location.protocol}//portainer.${host}/`;
    }
    this.groups = this.buildGroups();
  }

  /** Grouped by what people come to do; role checks match the routes' guards. */
  buildGroups(): NavGroup[] {
    const groups: NavGroup[] = [
      { label: 'Workspace', items: [
        { label: 'Dashboard', icon: 'dashboard', route: '/dashboard', exact: true },
        { label: 'Projects', icon: 'projects', route: '/projects' },
      ] },
      { label: 'Monitor', items: [
        { label: 'Observability', icon: 'observability', route: '/observability' },
        { label: 'Errors', icon: 'errors', route: '/errors' },
        { label: 'Alerts', icon: 'alerts', route: '/alerting' },
      ] },
    ];
    const operate: NavItem[] = [];
    if (this.isDevOps) operate.push({ label: 'Infrastructure', icon: 'infrastructure', route: '/infrastructure' });
    // Full-page navigation (not iframe): nginx serves Argo CD at /argocd/.
    operate.push({ label: 'Argo CD', icon: 'argocd', href: '/argocd/' });
    operate.push({ label: 'Grafana', icon: 'grafana', route: '/grafana' });
    operate.push({ label: 'Portainer', icon: 'portainer', href: this.portainerUrl });
    groups.push({ label: 'Operate', items: operate });
    const admin: NavItem[] = [];
    if (this.canManageUsers) admin.push({ label: 'Users', icon: 'users', route: '/users' });
    admin.push({ label: 'Settings', icon: 'settings', route: '/settings' });
    groups.push({ label: 'Admin', items: admin });
    return groups;
  }

  themeLabel(): string {
    const c = this.theme.choice();
    return c === 'system' ? 'Theme: system' : c === 'light' ? 'Theme: light' : 'Theme: dark';
  }

  /** Close the mobile drawer when any link inside it is followed. */
  onNavClick(event: Event) {
    const target = event.target as HTMLElement | null;
    if (target?.closest?.('a')) this.navigate.emit();
  }

  logout() {
    this.auth.logout();
  }
}
