import { Component, HostListener, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, RouterModule } from '@angular/router';
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
  loaded = false;
  showCreate = false;
  creating = false;
  createError = '';
  filter = '';
  /** Project whose row menu is open. */
  menuFor: string | null = null;
  newProject: any = { name: '', stack: 'nodejs', repositoryUrl: '', domain: '' };

  readonly stacks: Record<string, string> = {
    nodejs: 'Node.js', angular: 'Angular', python: 'Python', static: 'Static site', react: 'React', go: 'Go',
  };

  constructor(private api: ApiService, private route: ActivatedRoute) {}

  async ngOnInit() {
    // Global search's "New project" opens the form directly.
    if (this.route.snapshot?.queryParamMap?.get('new') === '1') this.showCreate = true;
    try { this.projects = await firstValueFrom(this.api.getProjects()); } catch { this.projects = []; }
    this.loaded = true;
  }

  get visible(): any[] {
    const q = this.filter.trim().toLowerCase();
    if (!q) return this.projects;
    return this.projects.filter((p) =>
      [p.name, p.domain, p.repositoryUrl, p.stack].some((v) => String(v || '').toLowerCase().includes(q)));
  }

  /** "owner/repo" from a GitHub/GitLab URL, for display. */
  repoName(url: string | undefined): string {
    if (!url) return '';
    const m = /^(?:https?:\/\/[^/]+\/|git@[^:]+:)(.+?)(?:\.git)?\/?$/.exec(url.trim());
    return m ? m[1] : url;
  }

  provider(url: string | undefined): string {
    if (!url) return '';
    if (url.includes('gitlab')) return 'GitLab';
    if (url.includes('github')) return 'GitHub';
    return 'Git';
  }

  /** Status shown as a dot and a word; unknown values read as neutral. */
  statusOf(p: any): { label: string; tone: string } {
    const s = String(p?.status || '').toLowerCase();
    if (['failed', 'error', 'degraded'].includes(s)) return { label: 'Needs attention', tone: 'status-down' };
    if (['deploying', 'pending', 'syncing', 'progressing'].includes(s)) return { label: 'Deploying', tone: 'status-warn' };
    if (['archived', 'paused', 'stopped'].includes(s)) return { label: s.charAt(0).toUpperCase() + s.slice(1), tone: '' };
    if (s) return { label: 'Running', tone: 'status-ok' };
    return { label: 'No deployments', tone: '' };
  }

  toggleMenu(id: string, event: Event) {
    event.stopPropagation();
    this.menuFor = this.menuFor === id ? null : id;
  }

  @HostListener('document:click')
  @HostListener('document:keydown.escape')
  closeMenu() {
    this.menuFor = null;
  }

  async create() {
    this.creating = true;
    this.createError = '';
    try {
      const p = await firstValueFrom(this.api.createProject(this.newProject));
      this.projects.push(p);
      this.showCreate = false;
      this.newProject = { name: '', stack: 'nodejs', repositoryUrl: '', domain: '' };
    } catch (err: any) {
      this.createError = 'The project was not created: ' + (err?.error?.error || err?.message || 'unknown error');
      alert(this.createError);
    } finally {
      this.creating = false;
    }
  }

  async delete(id: string) {
    this.menuFor = null;
    if (!confirm('Delete this project? Its environments, deployments and data connections are removed too.')) return;
    try {
      await firstValueFrom(this.api.deleteProject(id));
      this.projects = this.projects.filter(p => p.id !== id);
    } catch {}
  }
}
