import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { provideRouter, Router } from '@angular/router';
import { of } from 'rxjs';
import {
  RECENT_KEY, SearchItem, SearchService, buildPageItems, docItems, projectJumps, rankItems, rankMatch,
} from './search.service';
import { ApiService } from './api.service';
import { AuthService } from './auth.service';
import { ThemeService } from './theme.service';

describe('rankMatch', () => {
  it('orders exact > prefix > word start > substring', () => {
    expect(rankMatch('alerts', 'Alerts')).toBe(100);
    expect(rankMatch('ale', 'Alerts')).toBe(80);
    expect(rankMatch('sec', 'Rotate secrets')).toBe(60);
    expect(rankMatch('ert', 'Alerts')).toBe(40);
    expect(rankMatch('xyz', 'Alerts')).toBe(0);
  });

  it('is case and whitespace insensitive and handles empty input', () => {
    expect(rankMatch('  ALE ', 'alerts')).toBe(80);
    expect(rankMatch('', 'Alerts')).toBe(0);
    expect(rankMatch('a', '')).toBe(0);
  });

  it('matches several words that each start a word', () => {
    expect(rankMatch('rot sec', 'Rotate the secrets')).toBe(50);
  });
});

describe('rankItems', () => {
  const items: SearchItem[] = [
    { id: 'a', group: 'pages', label: 'Shop errors' },
    { id: 'b', group: 'pages', label: 'Errors' },
    { id: 'c', group: 'pages', label: 'Terrors' },
    { id: 'd', group: 'pages', label: 'Observability', keywords: ['errors overview'] },
    { id: 'e', group: 'pages', label: 'Unrelated' },
  ];

  it('returns matches best first and drops non-matches', () => {
    expect(rankItems('err', items).map((i) => i.id)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('caps results at the limit', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: 'p' + i, group: 'pages' as const, label: 'Page ' + i }));
    expect(rankItems('page', many).length).toBe(8);
  });
});

describe('projectJumps', () => {
  const projects = [{ id: 'p1', name: 'Shop' }, { id: 'p2', name: 'Shop admin' }, { id: 'p3', name: 'Blog' }];

  it('links "shop logs" to the monitoring logs view', () => {
    const jumps = projectJumps('shop logs', projects);
    expect(jumps[0].route).toBe('/projects/p1');
    expect(jumps[0].queryParams).toEqual({ tab: 'monitoring', view: 'logs' });
    expect(jumps[0].label).toBe('Shop: Logs');
  });

  it('maps deploy and settings to project tabs', () => {
    expect(projectJumps('shop deploy', projects).find((j) => j.route === '/projects/p1')?.queryParams).toEqual({ tab: 'deployments' });
    expect(projectJumps('blog settings', projects)[0].queryParams).toEqual({ tab: 'settings' });
  });

  it('handles multi-word project names and needs a section word', () => {
    expect(projectJumps('shop admin errors', projects).some((j) => j.route === '/projects/p2' && j.queryParams?.['view'] === 'errors')).toBeTrue();
    expect(projectJumps('shop', projects)).toEqual([]);
    expect(projectJumps('shop zzz', projects)).toEqual([]);
  });
});

describe('buildPageItems role filtering', () => {
  const routes = (items: SearchItem[]) => items.map((i) => i.route || i.href);

  it('hides Users, Infrastructure and devops settings tabs from a developer', () => {
    const items = buildPageItems({ isDevOps: false, canManageUsers: false });
    expect(routes(items)).not.toContain('/users');
    expect(routes(items)).not.toContain('/infrastructure');
    const settings = items.filter((i) => i.route === '/settings' && i.queryParams);
    expect(settings.map((i) => i.queryParams!['tab'])).toEqual(['integrations']);
    expect(routes(items)).toEqual(jasmine.arrayContaining(['/dashboard', '/projects', '/observability', '/alerting', '/profile', '/settings']));
  });

  it('shows everything to devops/admin', () => {
    const items = buildPageItems({ isDevOps: true, canManageUsers: true });
    expect(routes(items)).toEqual(jasmine.arrayContaining(['/users', '/infrastructure']));
    const tabs = items.filter((i) => i.route === '/settings' && i.queryParams).map((i) => i.queryParams!['tab']);
    expect(tabs).toEqual(['login', 'integrations', 'smtp', 'storage', 'rotate', 'security']);
  });

  it('finds Observability by the word monitoring', () => {
    const items = buildPageItems({ isDevOps: false, canManageUsers: false });
    expect(rankItems('monitoring', items)[0].route).toBe('/observability');
  });
});

describe('docItems', () => {
  it('keeps one entry per page title from the docs index', () => {
    const items = docItems({
      version: 1, documents: 2, entries: [
        { url: '/docs/guides/secrets', title: 'Secrets', section: 'guides', heading: 'Secrets', text: '' },
        { url: '/docs/guides/secrets#rotate', title: 'Secrets', section: 'guides', heading: 'Rotate', text: '' },
        { url: '/docs', title: 'Overview', section: 'Overview', heading: 'Overview', text: '' },
      ],
    });
    expect(items.map((i) => i.label)).toEqual(['Secrets', 'Overview']);
    expect(items[0].href).toBe('https://cairnpaas.dev/docs/guides/secrets');
  });
});

describe('SearchService', () => {
  let service: SearchService;
  let auth: jasmine.SpyObj<AuthService>;
  let api: jasmine.SpyObj<ApiService>;
  let theme: jasmine.SpyObj<ThemeService>;

  beforeEach(() => {
    localStorage.removeItem(RECENT_KEY);
    auth = jasmine.createSpyObj('AuthService', ['isDevOps', 'isAdmin', 'canManageUsers', 'logout']);
    auth.isDevOps.and.returnValue(false);
    auth.isAdmin.and.returnValue(false);
    auth.canManageUsers.and.returnValue(false);
    api = jasmine.createSpyObj('ApiService', ['getProjects']);
    api.getProjects.and.returnValue(of([{ id: 'p1', name: 'Shop', domain: 'shop.example.com' }]));
    theme = jasmine.createSpyObj('ThemeService', ['cycle']);
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]), provideHttpClient(), provideHttpClientTesting(),
        { provide: AuthService, useValue: auth },
        { provide: ApiService, useValue: api },
        { provide: ThemeService, useValue: theme },
      ],
    });
    service = TestBed.inject(SearchService);
  });

  afterEach(() => localStorage.removeItem(RECENT_KEY));

  it('caches projects and refetches only when older than 60 s', async () => {
    await service.refreshProjects();
    await service.refreshProjects();
    expect(api.getProjects).toHaveBeenCalledTimes(1);
    expect(service.search('shop')[0].items[0].route).toBe('/projects/p1');
    await service.refreshProjects(true);
    expect(api.getProjects).toHaveBeenCalledTimes(2);
  });

  it('puts the group with the best match first', async () => {
    await service.refreshProjects();
    const groups = service.search('sign out');
    expect(groups[0].id).toBe('actions');
    expect(groups[0].items[0].action).toBe('sign-out');
  });

  it('loads doc titles once from the docs index', async () => {
    const p = service.loadDocs();
    TestBed.inject(HttpTestingController).expectOne('/docs-search.json').flush({
      version: 1, documents: 1, entries: [{ url: '/docs/faq', title: 'FAQ', section: 'Overview', heading: 'FAQ', text: '' }],
    });
    await p;
    await service.loadDocs();
    TestBed.inject(HttpTestingController).verify();
    expect(service.search('faq').find((g) => g.id === 'docs')?.items[0].label).toBe('FAQ');
  });

  it('remembers the last 5 picks and shows them for an empty query', () => {
    for (let i = 0; i < 7; i++) service.remember({ id: 'project:' + i, group: 'projects', label: 'P' + i, route: '/projects/' + i });
    service.remember({ id: 'project:3', group: 'projects', label: 'P3', route: '/projects/3' });
    const groups = service.search('');
    expect(groups[0].id).toBe('recent');
    expect(groups[0].items.map((i) => i.label)).toEqual(['P3', 'P6', 'P5', 'P4', 'P2']);
  });

  it('drops recent pages the role can no longer open and survives bad storage data', () => {
    localStorage.setItem(RECENT_KEY, JSON.stringify([
      { id: 'page:/users', group: 'pages', label: 'Users', route: '/users' },
      { id: 'page:/alerting', group: 'pages', label: 'Alerts', route: '/alerting' },
    ]));
    expect(service.search('')[0].items.map((i) => i.label)).toEqual(['Alerts']);
    localStorage.setItem(RECENT_KEY, '{not json');
    expect(service.search('')).toEqual([]);
  });

  it('runs actions and navigates to routes with query params', () => {
    const router = TestBed.inject(Router);
    const nav = spyOn(router, 'navigate').and.resolveTo(true);
    service.open();
    service.select({ id: 'action:toggle-theme', group: 'actions', label: 'Toggle theme', action: 'toggle-theme' });
    expect(theme.cycle).toHaveBeenCalled();
    expect(service.isOpen()).toBeFalse();
    service.select({ id: 'action:sign-out', group: 'actions', label: 'Sign out', action: 'sign-out' });
    expect(auth.logout).toHaveBeenCalled();
    service.select({ id: 'x', group: 'pages', label: 'Settings: Email', route: '/settings', queryParams: { tab: 'smtp' } });
    expect(nav).toHaveBeenCalledWith(['/settings'], { queryParams: { tab: 'smtp' } });
  });
});
