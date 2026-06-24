import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../services/api.service';

@Component({
  selector: 'app-projects',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule],
  templateUrl: './projects.component.html',
  styleUrl: './projects.component.css'
})
export class ProjectsComponent implements OnInit {
  projects: any[] = [];
  showCreate = false;
  newProject: any = { name: '', stack: 'nodejs', repositoryUrl: '' };

  constructor(private api: ApiService) {}

  async ngOnInit() {
    try { this.projects = await firstValueFrom(this.api.getProjects()); } catch { this.projects = []; }
  }

  async create() {
    try {
      const p = await firstValueFrom(this.api.createProject(this.newProject));
      this.projects.push(p);
      this.showCreate = false;
      this.newProject = { name: '', stack: 'nodejs', repositoryUrl: '' };
    } catch (err: any) { alert('Failed to create project: ' + (err.error?.error || err.message)); }
  }

  async delete(id: string) {
    if (!confirm('Delete project? This will also remove all environments and deployments.')) return;
    try {
      await firstValueFrom(this.api.deleteProject(id));
      this.projects = this.projects.filter(p => p.id !== id);
    } catch {}
  }
}
