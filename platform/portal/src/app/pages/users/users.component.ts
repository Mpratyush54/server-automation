import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';

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
    isActive: true,
  };

  constructor(private api: ApiService, private auth: AuthService) {}

  async ngOnInit() {
    this.canManage = this.auth.canManageUsers();
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
