import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { MfaService } from '../../services/mfa.service';
import { StepUpService } from '../../services/step-up.service';

@Component({
  selector: 'app-users',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './users.component.html',
  styleUrl: './users.component.css'
})
export class UsersComponent implements OnInit {
  users: any[] = [];
  showModal = false;
  isEditMode = false;
  canManage = false;
  loadError = '';

  currentUser = {
    id: '',
    name: '',
    email: '',
    username: '',
    role: 'developer',
    password: '',
    gitlabId: '',
    githubId: '',
    isActive: true,
  };

  isAdmin = false;
  private mfa = inject(MfaService);
  private stepUp = inject(StepUpService);

  constructor(private api: ApiService, private auth: AuthService) {}

  /** Admin reset of a user's MFA (lost device); needs the admin's own recent second factor (#24). */
  async resetMfa(u: any) {
    if (!this.isAdmin) return;
    if (!confirm(`Remove the authenticator of ${u.email}? They will enrol again at next sign-in if their role requires it.`)) return;
    try {
      await this.stepUp.run(() => firstValueFrom(this.mfa.adminReset(u.id, 'reset from portal')), `Reset MFA for ${u.email}`);
      await this.loadUsers();
    } catch (err: any) {
      alert('Failed to reset MFA: ' + (err.error?.error || err.message));
    }
  }

  async ngOnInit() {
    this.canManage = this.auth.canManageUsers();
    this.isAdmin = this.auth.isAdmin();
    await this.loadUsers();
  }

  async loadUsers() {
    this.loadError = '';
    try {
      this.users = await firstValueFrom(this.api.getUsers());
    } catch (err: any) {
      this.loadError = err.error?.error || err.message || 'Failed to load users';
      this.users = [];
    }
  }

  openCreateModal() {
    if (!this.canManage) return;
    this.isEditMode = false;
    this.currentUser = {
      id: '',
      name: '',
      email: '',
      username: '',
      role: 'developer',
      password: '',
      gitlabId: '',
      githubId: '',
      isActive: true,
    };
    this.showModal = true;
  }

  openEditModal(user: any) {
    if (!this.canManage) return;
    this.isEditMode = true;
    this.currentUser = {
      id: user.id,
      name: user.name,
      email: user.email,
      username: user.username || '',
      role: user.role,
      password: '',
      gitlabId: user.gitlabId || '',
      githubId: user.githubId || '',
      isActive: user.isActive !== false,
    };
    this.showModal = true;
  }

  closeModal() {
    this.showModal = false;
  }

  async saveUser() {
    if (!this.canManage) return;
    if (!this.isEditMode && (!this.currentUser.password || this.currentUser.password.length < 8)) {
      alert('Password is required (min 8 characters) so the user can log in.');
      return;
    }
    try {
      const payload: any = {
        name: this.currentUser.name,
        email: this.currentUser.email,
        username: this.currentUser.username || undefined,
        role: this.currentUser.role,
        gitlabId: this.currentUser.gitlabId || null,
        githubId: this.currentUser.githubId || null,
        isActive: this.currentUser.isActive,
      };
      if (this.currentUser.password) payload.password = this.currentUser.password;

      if (this.isEditMode) {
        await firstValueFrom(this.api.updateUser(this.currentUser.id, payload));
      } else {
        await firstValueFrom(this.api.createUser(payload));
      }
      this.showModal = false;
      await this.loadUsers();
    } catch (err: any) {
      alert('Failed to save user: ' + (err.error?.error || err.message));
    }
  }

  async deleteUser(id: string) {
    if (!this.canManage) return;
    if (!confirm('Are you sure you want to delete this user?')) return;
    try {
      await firstValueFrom(this.api.deleteUser(id));
      await this.loadUsers();
    } catch (err: any) {
      alert('Failed to delete user: ' + (err.error?.error || err.message));
    }
  }
}
