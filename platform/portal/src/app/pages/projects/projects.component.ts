import { Component, HostListener, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../services/api.service';
import { ToastService, errorText } from '../../shared/feedback/feedback.service';
import { AppRow, Tone, buildApps, timeAgo } from '../dashboard/dashboard-model';
import { parseRepo } from '../new-project/new-project-model';
import { DeleteProjectDialogComponent, DeleteDialogResult } from '../project-detail/delete-project-dialog.component';

export type StatusFilter = 'all' | 'attention' | 'running' | 'idle';
export type SortKey = 'recent' | 'name' | 'status';
export type ViewMode = 'list' | 'grid';

/** One project on the list: the dashboard's app row plus what only this page shows. */
export interface ProjectRow extends AppRow {
  stack: string;
  description: string;
  provider: string | null;
  repo: string | null;
  repoUrl: string | null;
  /** Lowercased text the search box matches against. */
  haystack: string;
}

export const VIEW_KEY = 'cairn.projects.view';

const STACKS: Record<string, string> = {
  nodejs: 'Node.js', angular: 'Angular', python: 'Python', static: 'Static site', react: 'React', go: 'Go',
};

export function stackLabel(s: string | undefined): string {
  return STACKS[String(s || '')] || String(s || '');
}

export function toRows(projects: any[]): ProjectRow[] {
  const byId = new Map((projects || []).map((p: any) => [p.id, p]));
  return buildApps(projects).map((a) => {
    const p: any = byId.get(a.id) || {};
    const r = parseRepo(p.repositoryUrl);
    const stack = stackLabel(p.stack);
    return {
      ...a,
      stack,
      description: p.description || '',
      provider: r ? r.provider : null,
      repo: r ? r.ownerRepo : (p.repositoryUrl || null),
      repoUrl: p.repositoryUrl || null,
      haystack: [a.name, a.url, p.domain, p.repositoryUrl, stack, p.description].filter(Boolean).join(' ').toLowerCase(),
    };
  });
}

export function matchesFilter(r: AppRow, f: StatusFilter): boolean {
  if (f === 'attention') return r.tone === 'down';
  if (f === 'running') return r.tone === 'ok';
  if (f === 'idle') return r.tone === 'neutral';
  return true;
}

const rank = (t: Tone) => (t === 'down' ? 0 : t === 'warn' ? 1 : t === 'ok' ? 2 : 3);

export function sortRows<T extends AppRow>(rows: T[], key: SortKey): T[] {
  const out = [...rows];
  const byName = (a: T, b: T) => a.name.localeCompare(b.name);
  if (key === 'name') return out.sort(byName);
  if (key === 'status') return out.sort((a, b) => rank(a.tone) - rank(b.tone) || byName(a, b));
  // Recently deployed first; never-deployed apps last, by name.
  const at = (r: T) => (r.lastAt ? Date.parse(r.lastAt) || 0 : 0);
  return out.sort((a, b) => at(b) - at(a) || byName(a, b));
}

export function filterRows<T extends ProjectRow>(rows: T[], query: string, f: StatusFilter, key: SortKey): T[] {
  const q = query.trim().toLowerCase();
  return sortRows(rows.filter((r) => matchesFilter(r, f) && (!q || r.haystack.includes(q))), key);
}

@Component({
  selector: 'app-projects',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule, DeleteProjectDialogComponent],
  templateUrl: './projects.component.html',
  styleUrl: './projects.component.css'
})
export class ProjectsComponent implements OnInit {
  private api = inject(ApiService);
  private toast = inject(ToastService);

  projects: any[] = [];
  rows: ProjectRow[] = [];
  visible: ProjectRow[] = [];
  loaded = false;
  loadError = '';

  query = '';
  statusFilter: StatusFilter = 'all';
  sort: SortKey = 'recent';
  view: ViewMode = 'list';
  counts: Record<StatusFilter, number> = { all: 0, attention: 0, running: 0, idle: 0 };

  /** Project whose actions menu is open. */
  menuFor: string | null = null;

  readonly filters: { id: StatusFilter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'attention', label: 'Needs attention' },
    { id: 'running', label: 'Running' },
    { id: 'idle', label: 'Not deployed' },
  ];
  readonly timeAgo = timeAgo;

  async ngOnInit() {
    this.view = this.readView();
    await this.load();
  }

  async load() {
    this.loadError = '';
    try {
      const list = await firstValueFrom(this.api.getProjects());
      this.setProjects(Array.isArray(list) ? list : []);
    } catch (err) {
      this.loadError = `Projects could not be loaded: ${errorText(err)}. Check your connection and try again.`;
      this.setProjects([]);
    }
    this.loaded = true;
  }

  setProjects(list: any[]) {
    this.projects = list;
    this.rows = toRows(list);
    this.counts = {
      all: this.rows.length,
      attention: this.rows.filter((r) => matchesFilter(r, 'attention')).length,
      running: this.rows.filter((r) => matchesFilter(r, 'running')).length,
      idle: this.rows.filter((r) => matchesFilter(r, 'idle')).length,
    };
    this.refresh();
  }

  refresh() {
    this.visible = filterRows(this.rows, this.query, this.statusFilter, this.sort);
  }

  setFilter(f: StatusFilter) { this.statusFilter = f; this.refresh(); }

  clearFilters() { this.query = ''; this.statusFilter = 'all'; this.refresh(); }

  setView(v: ViewMode) {
    this.view = v;
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* private mode: keep it for this visit */ }
  }

  private readView(): ViewMode {
    try { return localStorage.getItem(VIEW_KEY) === 'grid' ? 'grid' : 'list'; } catch { return 'list'; }
  }

  toneClass(t: Tone): string {
    return t === 'ok' ? 'status-ok' : t === 'warn' ? 'status-warn' : t === 'down' ? 'status-down' : '';
  }

  host(url: string | null): string {
    return url ? url.replace(/^https?:\/\//, '') : '';
  }

  // ── Row actions menu ───────────────────────────────────────────────────────

  toggleMenu(id: string, event: Event) {
    event.stopPropagation();
    if (this.menuFor === id) { this.menuFor = null; return; }
    this.menuFor = id;
    const trigger = event.currentTarget as HTMLElement | null;
    // Keyboard users land on the first item.
    setTimeout(() => trigger?.parentElement?.querySelector<HTMLElement>('[role="menuitem"]')?.focus(), 0);
  }

  /** Arrow keys move through items, Home/End jump, Escape closes and returns focus. */
  menuKey(event: KeyboardEvent) {
    const menu = event.currentTarget as HTMLElement;
    const items = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    const i = items.indexOf(document.activeElement as HTMLElement);
    let next = -1;
    if (event.key === 'ArrowDown') next = (i + 1) % items.length;
    else if (event.key === 'ArrowUp') next = (i - 1 + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.menuFor = null;
      menu.parentElement?.querySelector<HTMLElement>('.pj-menu-btn')?.focus();
      return;
    } else if (event.key === 'Tab') { this.menuFor = null; return; }
    if (next >= 0) { event.preventDefault(); items[next]?.focus(); }
  }

  @HostListener('document:click')
  @HostListener('document:keydown.escape')
  closeMenu() {
    this.menuFor = null;
  }

  /** Project the delete dialog is open for. */
  deleting: { id: string; name: string } | null = null;

  delete(row: { id: string; name: string }) {
    this.menuFor = null;
    this.deleting = { id: row.id, name: row.name };
  }

  async onDeleteClosed(result: DeleteDialogResult) {
    const row = this.deleting;
    this.deleting = null;
    if (!row) return;
    if (result === 'deleted') {
      this.setProjects(this.projects.filter((p) => p.id !== row.id));
      this.toast.ok(`Deleted ${row.name}`);
    } else if (result === 'left') {
      // Still being deleted (or stopped with an error): show its current state.
      await this.load();
    }
  }
}
