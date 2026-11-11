import { Component, OnInit, Input, Output, EventEmitter } from '@angular/core';
import { RouterModule } from '@angular/router';

import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-sidebar',
  standalone: true,
  imports: [RouterModule],
  templateUrl: './sidebar.component.html',
  styleUrl: './sidebar.component.css'
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

  constructor(private auth: AuthService) {}

  ngOnInit() {
    this.isDevOps = this.auth.isDevOps() || this.auth.isAdmin();
    this.isTechLeadOrDevOps = this.auth.isTechLeadOrDevOps();
    this.canManageUsers = this.auth.canManageUsers();
    const host = window.location.hostname;
    if (host !== 'localhost' && host !== '127.0.0.1') {
      this.portainerUrl = `${window.location.protocol}//portainer.${host}/`;
    }
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
