import { Component, Input, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../services/auth.service';
import { firstValueFrom } from 'rxjs';

@Component({
  selector: 'app-header',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './header.component.html',
  styleUrl: './header.component.css'
})
export class HeaderComponent implements OnInit {
  @Input() title = 'Dashboard';

  roles = [
    { name: 'Developer', id: 'developer', email: 'john@caps.io' },
    { name: 'Tech Lead', id: 'tech_lead', email: 'sarah@caps.io' },
    { name: 'DevOps', id: 'devops', email: 'devops@caps.io' }
  ];

  selectedRole = 'developer';
  currentUser: any = null;

  constructor(private auth: AuthService) {}

  ngOnInit() {
    this.currentUser = this.auth.getUser();
    this.selectedRole = this.auth.getRole();
  }

  async onRoleChange() {
    const roleObj = this.roles.find(r => r.id === this.selectedRole);
    if (roleObj) {
      try {
        await firstValueFrom(this.auth.login(roleObj.email));
        window.location.reload();
      } catch (err: any) {
        alert('Failed to switch mock role: ' + (err.error?.error || err.message));
      }
    }
  }
}
