import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from './api.service';
import { AuthService } from './auth.service';
import { ThemeService } from './theme.service';
import { SidebarComponent, NavGroup } from '../layout/sidebar/sidebar.component';
import type { DocsSearchIndex } from '../pages/docs/docs-search';

export type SearchGroupId = 'recent' | 'projects' | 'pages' | 'docs' | 'actions';
export type SearchActionId = 'new-project' | 'toggle-theme' | 'sign-out';

/** One palette entry. Plain data (no functions) so it can be kept in recent selections. */
export interface SearchItem {
  id: string;
  group: Exclude<SearchGroupId, 'recent'>;
  label: string;
  /** Short secondary text shown on the right, e.g. a section or project name. */
  hint?: string;
  /** Extra words that should find this entry (matched a little below the label). */
  keywords?: string[];
  route?: string;
  queryParams?: Record<string, string>;
  /** Full-page link (another app next to the portal, or the public docs). */
  href?: string;
  /** Open href in a new tab. */
  newTab?: boolean;
  action?: SearchActionId;
}

export interface SearchGroup {
  id: SearchGroupId;
  label: string;
  items: SearchItem[];
}

export const RECENT_KEY = 'platform.search.recent';
export const RECENT_LIMIT = 5;
export const GROUP_LIMIT = 8;
const PROJECTS_MAX_AGE_MS = 60_000;
/** Same public docs site the sidebar links to. */
export const DOCS_ORIGIN = 'https://platform.pratyushes.dev';

const GROUP_LABELS: Record<SearchGroupId, string> = {
  recent: 'Recent',
  projects: 'Projects',
  pages: 'Pages',
  docs: 'Docs',
  actions: 'Actions',
};
const GROUP_ORDER: SearchGroupId[] = ['projects', 'pages', 'docs', 'actions'];

/**
 * Rank how well `query` matches `text`: 0 = no match, higher is better.
 * exact (100) > prefix (80) > start of a word (60) > anywhere (40).
 * A query of several words that each start a word in the text scores 50.
 */
export function rankMatch(query: string, text: string): number {
  const q = normalize(query);
  const t = normalize(text);
  if (!q || !t) return 0;
  if (t === q) return 100;
  if (t.startsWith(q)) return 80;
  const words = t.split(/[^a-z0-9]+/).filter(Boolean);
  if (words.some((w, i) => i > 0 && w.startsWith(q)) || t.includes(' ' + q)) return 60;
  if (t.includes(q)) return 40;
  const parts = q.split(' ').filter(Boolean);
  if (parts.length > 1 && parts.every((p) => words.some((w) => w.startsWith(p)))) return 50;
  return 0;
}

/** Best rank over the label, with keywords counting a little less. */
export function rankItem(query: string, item: Pick<SearchItem, 'label' | 'keywords' | 'hint'>): number {
  let best = rankMatch(query, item.label);
  for (const k of item.keywords || []) best = Math.max(best, rankMatch(query, k) - 5);
  if (item.hint) best = Math.max(best, rankMatch(query, item.hint) - 20);
  return Math.max(best, 0);
}

/** Items that match, best first (stable for equal scores), at most `limit`. */
export function rankItems(query: string, items: SearchItem[], limit = GROUP_LIMIT): SearchItem[] {
  return items
    .map((item, index) => ({ item, index, score: rankItem(query, item) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((r) => r.item);
}

function normalize(s: string): string {
  return String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Project sections people can jump to: "shop logs", "shop deploy", "shop settings". */
interface Section { label: string; words: string[]; tab: string; view?: string }
export const PROJECT_SECTIONS: Section[] = [
  { label: 'Overview', words: ['overview', 'summary'], tab: 'overview' },
  { label: 'Deployments', words: ['deployments', 'deploy', 'releases', 'builds'], tab: 'deployments' },
  { label: 'Configuration', words: ['configuration', 'config', 'env', 'environment', 'variables', 'secrets'], tab: 'configuration' },
  { label: 'Data', words: ['data', 'database', 'db', 'backups', 'storage'], tab: 'data' },
  { label: 'Monitoring', words: ['monitoring', 'monitor', 'observability'], tab: 'monitoring', view: 'overview' },
  { label: 'Errors', words: ['errors', 'exceptions', 'issues'], tab: 'monitoring', view: 'errors' },
  { label: 'Logs', words: ['logs'], tab: 'monitoring', view: 'logs' },
  { label: 'Traces', words: ['traces', 'tracing', 'spans'], tab: 'monitoring', view: 'traces' },
  { label: 'Users', words: ['users', 'sessions', 'replays'], tab: 'monitoring', view: 'users' },
  { label: 'Uptime', words: ['uptime', 'checks', 'synthetics'], tab: 'monitoring', view: 'uptime' },
  { label: 'Resources', words: ['resources', 'metrics', 'cpu', 'memory'], tab: 'monitoring', view: 'resources' },
  { label: 'AI agents', words: ['agents', 'mcp', 'ai'], tab: 'monitoring', view: 'agents' },
  { label: 'Settings', words: ['settings', 'privacy'], tab: 'settings' },
];

/**
 * Jump targets for a query made of a project name plus a section word.
 * The name part must match the project (prefix or word start); the rest must start a section word.
 */
export function projectJumps(query: string, projects: { id: string; name: string }[]): SearchItem[] {
  const words = normalize(query).split(' ').filter(Boolean);
  if (words.length < 2) return [];
  const out: SearchItem[] = [];
  const seen = new Set<string>();
  for (let split = words.length - 1; split >= 1; split--) {
    const head = words.slice(0, split).join(' ');
    const tail = words.slice(split).join(' ');
    for (const p of projects) {
      if (rankMatch(head, p.name) < 60) continue;
      for (const s of PROJECT_SECTIONS) {
        if (!s.words.some((w) => w.startsWith(tail))) continue;
        const id = `jump:${p.id}:${s.tab}:${s.view || ''}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const queryParams: Record<string, string> = { tab: s.tab };
        if (s.view) queryParams['view'] = s.view;
        out.push({ id, group: 'projects', label: `${p.name}: ${s.label}`, hint: 'Project', route: `/projects/${p.id}`, queryParams });
      }
    }
  }
  return out;
}

export interface RoleFlags {
  /** Same rule as the sidebar and Settings: devops or admin. */
  isDevOps: boolean;
  canManageUsers: boolean;
}

/** Settings sub-tabs (activeTab values in settings.component.ts); all but Git linking need devops/admin. */
const SETTINGS_TABS: { tab: string; label: string; keywords: string[]; devOps: boolean }[] = [
  { tab: 'login', label: 'Sign-in', keywords: ['oauth', 'login', 'sso'], devOps: true },
  { tab: 'integrations', label: 'Git linking', keywords: ['github', 'gitlab', 'git', 'integrations'], devOps: false },
  { tab: 'smtp', label: 'Email', keywords: ['smtp', 'mail'], devOps: true },
  { tab: 'storage', label: 'Storage', keywords: ['s3', 'minio', 'backup'], devOps: true },
  { tab: 'rotate', label: 'Rotate secrets', keywords: ['keys', 'rotation', 'secrets'], devOps: true },
  { tab: 'security', label: 'Security', keywords: ['mfa', 'two-factor', '2fa', 'policy'], devOps: true },
];

const PAGE_KEYWORDS: Record<string, string[]> = {
  '/observability': ['monitoring', 'metrics', 'logs', 'traces'],
  '/errors': ['exceptions', 'issues', 'error tracking'],
  '/alerting': ['alerts', 'notifications', 'rules'],
  '/infrastructure': ['servers', 'nodes', 'cluster', 'kubernetes'],
  '/users': ['team', 'members', 'roles', 'invite'],
  '/projects': ['apps', 'services'],
  '/dashboard': ['home'],
};

/**
 * Every page the user can open: the sidebar's own groups (built with the sidebar's own
 * role checks), Profile, Docs and the Settings sub-tabs.
 */
export function buildPageItems(flags: RoleFlags, portainerUrl = 'http://localhost:9000'): SearchItem[] {
  // Reuse SidebarComponent.buildGroups so the list and its role rules never drift from the sidebar.
  const groups: NavGroup[] = SidebarComponent.prototype.buildGroups.call({
    isDevOps: flags.isDevOps,
    canManageUsers: flags.canManageUsers,
    portainerUrl,
  } as unknown as SidebarComponent);
  const items: SearchItem[] = [];
  for (const g of groups) {
    for (const n of g.items) {
      const key = n.route || n.href || n.label;
      items.push({
        id: `page:${key}`,
        group: 'pages',
        label: n.label,
        hint: g.label,
        keywords: PAGE_KEYWORDS[n.route || ''],
        route: n.route,
        href: n.route ? undefined : n.href,
      });
    }
  }
  items.push({ id: 'page:/profile', group: 'pages', label: 'Profile', hint: 'Account', keywords: ['account', 'password', 'mfa', 'me'], route: '/profile' });
  items.push({ id: 'page:docs', group: 'pages', label: 'Docs', hint: 'Help', keywords: ['documentation', 'help', 'guides'], href: `${DOCS_ORIGIN}/docs`, newTab: true });
  const hasSettings = items.some((i) => i.route === '/settings');
  if (hasSettings) {
    for (const t of SETTINGS_TABS) {
      if (t.devOps && !flags.isDevOps) continue;
      items.push({
        id: `page:/settings?tab=${t.tab}`,
        group: 'pages',
        label: `Settings: ${t.label}`,
        hint: 'Settings',
        keywords: [t.label, ...t.keywords],
        route: '/settings',
        queryParams: { tab: t.tab },
      });
    }
  }
  return items;
}

export function buildActionItems(): SearchItem[] {
  return [
    { id: 'action:new-project', group: 'actions', label: 'New project', keywords: ['create project', 'add project'], action: 'new-project' },
    { id: 'action:toggle-theme', group: 'actions', label: 'Toggle theme', keywords: ['dark mode', 'light mode', 'appearance'], action: 'toggle-theme' },
    { id: 'action:sign-out', group: 'actions', label: 'Sign out', keywords: ['log out', 'logout'], action: 'sign-out' },
  ];
}

/** Doc page titles from the generated docs index (the one docs search uses); one entry per page. */
export function docItems(index: DocsSearchIndex | null): SearchItem[] {
  if (!index || !Array.isArray(index.entries)) return [];
  const seen = new Set<string>();
  const out: SearchItem[] = [];
  for (const e of index.entries) {
    if (!e?.url || e.url.includes('#') || seen.has(e.url)) continue;
    seen.add(e.url);
    out.push({ id: `doc:${e.url}`, group: 'docs', label: e.title, hint: e.section, href: DOCS_ORIGIN + e.url, newTab: true });
  }
  return out;
}

@Injectable({ providedIn: 'root' })
export class SearchService {
  private api = inject(ApiService);
  private auth = inject(AuthService);
  private theme = inject(ThemeService);
  private router = inject(Router);
  private http = inject(HttpClient);

  /** Palette open state, shared by the header field, the mobile button and shortcuts. */
  readonly isOpen = signal(false);

  private projects: { id: string; name: string; domain?: string }[] = [];
  private projectsFetchedAt = 0;
  private docs: SearchItem[] = [];
  private docsRequested = false;

  open(): void {
    this.isOpen.set(true);
    void this.refreshProjects();
    void this.loadDocs();
  }

  close(): void {
    this.isOpen.set(false);
  }

  /** Projects are cached for the session and refreshed when older than 60 s. */
  async refreshProjects(force = false): Promise<void> {
    if (!force && this.projectsFetchedAt && Date.now() - this.projectsFetchedAt < PROJECTS_MAX_AGE_MS) return;
    this.projectsFetchedAt = Date.now();
    try {
      const list = await firstValueFrom(this.api.getProjects());
      this.projects = (Array.isArray(list) ? list : []).filter((p: any) => p?.id && p?.name);
    } catch {
      this.projectsFetchedAt = 0;
    }
  }

  async loadDocs(): Promise<void> {
    if (this.docsRequested) return;
    this.docsRequested = true;
    try {
      const index = await firstValueFrom(this.http.get<DocsSearchIndex>('/docs-search.json'));
      this.docs = index?.version === 1 ? docItems(index) : [];
    } catch {
      this.docsRequested = false;
      this.docs = [];
    }
  }

  roleFlags(): RoleFlags {
    return {
      isDevOps: this.auth.isDevOps() || this.auth.isAdmin(),
      canManageUsers: this.auth.canManageUsers(),
    };
  }

  private portainerUrl(): string {
    const host = window.location.hostname;
    return host !== 'localhost' && host !== '127.0.0.1' ? `${window.location.protocol}//portainer.${host}/` : 'http://localhost:9000';
  }

  projectItems(): SearchItem[] {
    return this.projects.map((p) => ({
      id: `project:${p.id}`,
      group: 'projects' as const,
      label: p.name,
      hint: p.domain || 'Project',
      keywords: p.domain ? [p.domain] : undefined,
      route: `/projects/${p.id}`,
    }));
  }

  /** Grouped results for a query; groups with the best match come first. Empty query shows recent picks. */
  search(query: string): SearchGroup[] {
    const pages = buildPageItems(this.roleFlags(), this.portainerUrl());
    const actions = buildActionItems();
    if (!query.trim()) {
      const recent = this.recent(new Set([...pages, ...actions].map((i) => i.id)));
      return recent.length ? [{ id: 'recent', label: GROUP_LABELS.recent, items: recent }] : [];
    }
    const pools: Record<string, SearchItem[]> = {
      projects: [...projectJumps(query, this.projects), ...rankItems(query, this.projectItems())].slice(0, GROUP_LIMIT),
      pages: rankItems(query, pages),
      docs: rankItems(query, this.docs),
      actions: rankItems(query, actions),
    };
    const best = (items: SearchItem[]) => items.reduce((m, i) => Math.max(m, i.id.startsWith('jump:') ? 90 : rankItem(query, i)), 0);
    return GROUP_ORDER
      .filter((id) => pools[id].length)
      .map((id, order) => ({ id, order, score: best(pools[id]) }))
      .sort((a, b) => b.score - a.score || a.order - b.order)
      .map(({ id }) => ({ id, label: GROUP_LABELS[id], items: pools[id] }));
  }

  /** Recent selections; pages and actions the user can no longer open are dropped. */
  recent(allowed?: Set<string>): SearchItem[] {
    let items: SearchItem[] = [];
    try {
      const raw = localStorage.getItem(RECENT_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      items = Array.isArray(parsed) ? parsed.filter((i) => i && typeof i.id === 'string' && typeof i.label === 'string') : [];
    } catch {
      items = [];
    }
    if (allowed) items = items.filter((i) => !(i.group === 'pages' || i.group === 'actions') || allowed.has(i.id));
    return items.slice(0, RECENT_LIMIT);
  }

  remember(item: SearchItem): void {
    try {
      const next = [item, ...this.recent().filter((i) => i.id !== item.id)].slice(0, RECENT_LIMIT);
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {
      /* storage blocked: recent picks are a convenience only */
    }
  }

  /** Open or run an entry, remember it, and close the palette. */
  select(item: SearchItem): void {
    this.remember(item);
    this.close();
    if (item.action === 'toggle-theme') this.theme.cycle();
    else if (item.action === 'sign-out') this.auth.logout();
    else if (item.action === 'new-project') void this.router.navigate(['/projects'], { queryParams: { new: '1' } });
    else if (item.route) void this.router.navigate([item.route], { queryParams: item.queryParams });
    else if (item.href) {
      if (item.newTab) window.open(item.href, '_blank', 'noopener');
      else window.location.assign(item.href);
    }
  }
}
