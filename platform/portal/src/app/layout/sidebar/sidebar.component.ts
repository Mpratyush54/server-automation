import { Component, OnInit, Input, Output, EventEmitter } from '@angular/core';
import { RouterModule } from '@angular/router';
import { CommonModule } from '@angular/common';
import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-sidebar',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './sidebar.component.html',
  styleUrl: './sidebar.component.css'
})
export class SidebarComponent implements OnInit {
  @Input() isCollapsed = false;
  @Output() toggleCollapse = new EventEmitter<void>();
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

  logout() {
    this.auth.logout();
  }
}
