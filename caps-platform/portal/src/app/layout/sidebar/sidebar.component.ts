import { Component, OnInit } from '@angular/core';
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
  isDevOps = false;
  isTechLeadOrDevOps = false;

  constructor(private auth: AuthService) {}

  ngOnInit() {
    this.isDevOps = this.auth.isDevOps();
    this.isTechLeadOrDevOps = this.auth.isTechLeadOrDevOps();
  }

  logout() {
    this.auth.logout();
  }
}
