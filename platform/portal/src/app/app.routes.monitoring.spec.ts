import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, Routes, provideRouter } from '@angular/router';
import { routes } from './app.routes';

@Component({ standalone: true, template: '' })
class StubComponent {}

/** Old monitoring pages redirect to the project page's Monitoring section (?tab=monitoring&view=…). */
describe('Monitoring redirects', () => {
  const REDIRECT_PATHS = [
    'projects/:id/observability', 'projects/:id/errors', 'projects/:id/replays', 'projects/:id/heatmaps',
    'projects/:id/synthetics', 'projects/:id/status', 'errors',
  ];

  function setup(): Router {
    const real = routes.filter((r) => REDIRECT_PATHS.includes(r.path || ''));
    expect(real.length).toBe(REDIRECT_PATHS.length);
    const testRoutes: Routes = [
      ...real,
      { path: 'projects/:id', component: StubComponent },
      { path: 'projects/:id/replays/:sessionId', component: StubComponent },
      { path: 'observability', component: StubComponent },
    ];
    TestBed.configureTestingModule({ providers: [provideRouter(testRoutes)] });
    return TestBed.inject(Router);
  }

  const cases: [string, string][] = [
    ['/projects/p1/errors', '/projects/p1?tab=monitoring&view=errors'],
    ['/projects/p1/errors?issue=e1', '/projects/p1?issue=e1&tab=monitoring&view=errors'],
    ['/projects/p1/observability', '/projects/p1?tab=monitoring&view=overview'],
    ['/projects/p1/observability?tab=traces&since=6h', '/projects/p1?since=6h&tab=monitoring&view=traces'],
    ['/projects/p1/observability?tab=apm', '/projects/p1?tab=monitoring&view=traces'],
    ['/projects/p1/observability?tab=rum', '/projects/p1?tab=monitoring&view=users'],
    ['/projects/p1/observability?tab=infra', '/projects/p1?tab=monitoring&view=resources'],
    ['/projects/p1/observability?tab=synthetics', '/projects/p1?tab=monitoring&view=uptime'],
    ['/projects/p1/replays', '/projects/p1?tab=monitoring&view=users'],
    ['/projects/p1/heatmaps', '/projects/p1?tab=monitoring&view=users'],
    ['/projects/p1/synthetics?check=c1', '/projects/p1?check=c1&tab=monitoring&view=uptime'],
    ['/projects/p1/status', '/projects/p1?tab=monitoring&view=uptime'],
    ['/errors', '/observability'],
  ];
  for (const [from, to] of cases) {
    it(`${from} -> ${to}`, async () => {
      const router = setup();
      await router.navigateByUrl(from);
      expect(router.url).toBe(to);
    });
  }

  it('keeps the session replay player as its own page', async () => {
    const router = setup();
    await router.navigateByUrl('/projects/p1/replays/s1');
    expect(router.url).toBe('/projects/p1/replays/s1');
  });
});
