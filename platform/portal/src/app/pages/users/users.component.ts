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
  isDevOps = false;

  currentUser = {
    id: '',
    name: '',
    email: '',
    role: 'developer',
    gitlabId: ''
  };

  constructor(private api: ApiService, private auth: AuthService) {}

  async ngOnInit() {
    this.isDevOps = this.auth.isDevOps();
    await this.loadUsers();
  }

  async loadUsers() {
    try {
      this.users = await firstValueFrom(this.api.getUsers());
    } catch (err: any) {
      console.error('Failed to load users:', err.message);
    }
  }

  openCreateModal() {
    if (!this.isDevOps) return;
    this.isEditMode = false;
    this.currentUser = {
      id: '',
      name: '',
      email: '',
      role: 'developer',
      gitlabId: ''
    };
    this.showModal = true;
  }

  openEditModal(user: any) {
    if (!this.isDevOps) return;
    this.isEditMode = true;
    this.currentUser = { ...user };
    this.showModal = true;
  }

  closeModal() {
    this.showModal = false;
  }

  async saveUser() {
    if (!this.isDevOps) return;
    try {
      if (this.isEditMode) {
        await firstValueFrom(this.api.updateUser(this.currentUser.id, this.currentUser));
      } else {
        await firstValueFrom(this.api.createUser(this.currentUser));
      }
      this.showModal = false;
      await this.loadUsers();
    } catch (err: any) {
      alert('Failed to save user: ' + (err.error?.error || err.message));
    }
  }

  async deleteUser(id: string) {
    if (!this.isDevOps) return;
    if (!confirm('Are you sure you want to delete this user?')) return;
    try {
      await firstValueFrom(this.api.deleteUser(id));
      await this.loadUsers();
    } catch (err: any) {
      alert('Failed to delete user: ' + (err.error?.error || err.message));
    }
  }
}
