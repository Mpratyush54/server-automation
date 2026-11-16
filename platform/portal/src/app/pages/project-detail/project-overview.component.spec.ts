import { TestBed } from '@angular/core/testing';
import { ProjectOverviewComponent } from './project-overview.component';

describe('ProjectOverviewComponent (#185)', () => {
  const project = {
    id: 'p1', name: 'shop', repositoryUrl: 'https://github.com/acme/shop.git', defaultBranch: 'main',
    domain: 'shop.example.com', createdAt: '2026-01-01T00:00:00Z',
    environments: [
      { id: 'e-prod', name: 'production', namespace: 'shop-production', domain: 'shop.example.com' },
      { id: 'e-stg', name: 'staging', namespace: 'shop-staging', domain: 'staging.shop.example.com' },
    ],
  };
  const deployments = [
    { id: 'd1', environmentId: 'e-prod', version: 'v1.2.0', commitSha: 'abcdef1234567', status: 'deployed', deployedAt: '2026-02-01T10:00:00Z', deployedById: 'u1' },
    { id: 'd2', environmentId: 'e-prod', version: 'v1.3.0', commitSha: '1111111222222', status: 'failed', createdAt: '2026-02-02T10:00:00Z', deployedById: 'u2' },
    ...Array.from({ length: 5 }, (_, i) => ({ id: `old${i}`, environmentId: 'e-prod', version: `v0.${i}`, commitSha: 'f'.repeat(40), status: 'deployed', deployedAt: `2025-12-0${i + 1}T00:00:00Z` })),
  ];
  const members = [{ id: 'm1', userId: 'u1', role: 'owner', user: { name: 'Asha', email: 'asha@example.com' } }];

  function render(overrides: Partial<ProjectOverviewComponent> = {}) {
    TestBed.configureTestingModule({ imports: [ProjectOverviewComponent] });
    const fixture = TestBed.createComponent(ProjectOverviewComponent);
    Object.assign(fixture.componentInstance, { project, deployments, members, argoStatus: { connected: true, syncStatus: 'Synced', healthStatus: 'Healthy' } }, overrides);
    fixture.detectChanges();
    return fixture;
  }

  it('shows the current deployment per environment with status, commit, author and URL', () => {
    const el: HTMLElement = render().nativeElement;
    const prod = el.querySelector('[data-env="production"]')!;
    expect(prod.textContent).toContain('v1.2.0');
    expect(prod.textContent).toContain('abcdef1');
    expect(prod.textContent).toContain('Deployed');
    expect(prod.textContent).toContain('Asha');
    expect(prod.querySelector('a')!.getAttribute('href')).toBe('https://shop.example.com');
    const stg = el.querySelector('[data-env="staging"]')!;
    expect(stg.textContent).toContain('Not deployed');
    expect(stg.textContent).toContain('staging.shop.example.com');
  });

  it('lists at most five recent deployments, newest first, with unknown authors labelled', () => {
    const el: HTMLElement = render().nativeElement;
    const rows = Array.from(el.querySelectorAll('[data-testid="overview-recent"] tbody tr'));
    expect(rows.length).toBe(5);
    expect(rows[0].textContent).toContain('v1.3.0');
    expect(rows[0].textContent).toContain('Failed');
    expect(rows[0].textContent).toContain('Unknown user');
    expect(rows[1].textContent).toContain('v1.2.0');
  });

  it('shows key facts and health', () => {
    const el: HTMLElement = render().nativeElement;
    const facts = el.querySelector('[data-testid="overview-facts"]')!.textContent!;
    expect(facts).toContain('https://github.com/acme/shop.git');
    expect(facts).toContain('main');
    expect(facts).toContain('shop-production');
    expect(facts).toContain('shop-staging');
    expect(el.textContent).toContain('Healthy, synced');
    expect(el.textContent).toContain('No heartbeat data');
  });

  it('shows empty states and emits navigation from quick links', () => {
    const fixture = render({ deployments: [], project: { ...project, environments: [] } });
    const el: HTMLElement = fixture.nativeElement;
    expect(el.textContent).toContain('No environments');
    expect(el.textContent).toContain('No deployments yet');
    const nav = spyOn(fixture.componentInstance.navigate, 'emit');
    const link = Array.from(el.querySelectorAll<HTMLButtonElement>('.ov-links button')).find((b) => b.textContent!.includes('SDK tokens'))!;
    link.click();
    expect(nav).toHaveBeenCalledWith('settings');
  });
});
