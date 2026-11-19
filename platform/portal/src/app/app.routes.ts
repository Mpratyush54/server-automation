import { inject } from '@angular/core';
import { ActivatedRouteSnapshot, Params, RedirectFunction, Router, Routes } from '@angular/router';
import type { NewProjectComponent } from './pages/new-project/new-project.component';

import { LandingComponent } from './pages/landing/landing.component';
import { MonitoringView, viewForObsTab } from './pages/observability/monitoring-views';

import { authGuard } from './guards/auth.guard';
import { docsMatcher } from './guards/docs.matcher';
import { appHostGuard, marketingOnlyGuard, docsGuard } from './guards/public-domain.guard';
import { homeGuard, legacyLandingGuard } from './guards/home.guard';

/**
 * Old per-project monitoring pages now live in the project page's Monitoring
 * section: redirect to `/projects/:id?tab=monitoring&view=…`, keeping other query
 * params (since, env, trace, issue, check…). An old `?tab=` is consumed: the
 * project page owns `tab`.
 */
export function toMonitoring(view: MonitoringView | ((qp: Params) => MonitoringView)): RedirectFunction {
  return ({ params, queryParams }) => {
    const { tab, ...rest } = queryParams;
    const v = typeof view === 'function' ? view(queryParams) : view;
    return inject(Router).createUrlTree(['/projects', params['id']], { queryParams: { ...rest, tab: 'monitoring', view: v } });
  };
}

export const routes: Routes = [
  { path: '', pathMatch: 'full', component: LandingComponent, canActivate: [homeGuard] },

  // Marketing site only (cairnpaas.dev)
  { path: 'landing', canActivate: [marketingOnlyGuard, legacyLandingGuard], children: [] },
  { path: 'about', loadComponent: () => import('./pages/about/about.component').then(m => m.AboutComponent), canActivate: [marketingOnlyGuard], title: 'About Cairn' },
  { path: 'pricing', loadComponent: () => import('./pages/account/pricing.component').then(m => m.PricingComponent), canActivate: [marketingOnlyGuard], title: 'Pricing · Cairn' },
  { path: 'signup', loadComponent: () => import('./pages/account/signup.component').then(m => m.SignupComponent), canActivate: [marketingOnlyGuard], title: 'Get a free key · Cairn' },
  { path: 'signin', loadComponent: () => import('./pages/account/signin.component').then(m => m.SigninComponent), canActivate: [marketingOnlyGuard], title: 'Sign in · Cairn' },
  { path: 'verify-email', loadComponent: () => import('./pages/account/verify-email.component').then(m => m.VerifyEmailComponent), canActivate: [marketingOnlyGuard], title: 'Confirm your email · Cairn' },
  { path: 'account', loadComponent: () => import('./pages/account/account.component').then(m => m.AccountComponent), canActivate: [marketingOnlyGuard], title: 'Account · Cairn' },
  { matcher: docsMatcher, loadComponent: () => import('./pages/docs/docs.component').then(m => m.DocsComponent), canActivate: [docsGuard] },

  // App / server hosts only
  { path: 'login', loadComponent: () => import('./pages/login/login.component').then(m => m.LoginComponent), canActivate: [appHostGuard] },
  { path: 'oauth/authorize', loadComponent: () => import('./pages/oauth-authorize/oauth-authorize.component').then(m => m.OauthAuthorizeComponent), canActivate: [appHostGuard] },
  // Forced MFA enrolment for roles in mfa.requiredRoles (#24); the component checks the session.
  { path: 'mfa/enroll', loadComponent: () => import('./pages/mfa-enroll/mfa-enroll.component').then(m => m.MfaEnrollComponent), canActivate: [appHostGuard] },

  { path: 'dashboard', loadComponent: () => import('./pages/dashboard/dashboard.component').then(m => m.DashboardComponent), canActivate: [authGuard] },
  // ArgoCD is full-page at /argocd/ (ingress) — leave the SPA rather than iframe.
  {
    path: 'argocd',
    canActivate: [authGuard, () => {
      window.location.replace('/argocd/');
      return false;
    }],
    children: [],
  },
  { path: 'grafana', loadComponent: () => import('./pages/iframe-view/iframe-view.component').then(m => m.IframeViewComponent), canActivate: [authGuard], data: { url: '/grafana/' } },
  // Portainer cannot share the portal host (/api + JS assets collide) — open subdomain full-page.
  {
    path: 'portainer',
    canActivate: [authGuard, () => {
      const host = window.location.hostname;
      const url = (host === 'localhost' || host === '127.0.0.1')
        ? 'http://localhost:9000/'
        : `${window.location.protocol}//portainer.${host}/`;
      window.location.replace(url);
      return false;
    }],
    children: [],
  },

  // `/projects?new=1` (global search, dashboard) opens the new project wizard.
  { path: 'projects', loadComponent: () => import('./pages/projects/projects.component').then(m => m.ProjectsComponent), canActivate: [authGuard, (r: ActivatedRouteSnapshot) => r.queryParamMap.get('new') === '1' ? inject(Router).createUrlTree(['/projects/new']) : true] },
  { path: 'projects/new', loadComponent: () => import('./pages/new-project/new-project.component').then(m => m.NewProjectComponent), canActivate: [authGuard], canDeactivate: [(c: NewProjectComponent) => c.confirmLeave()] },
  { path: 'projects/:id', loadComponent: () => import('./pages/project-detail/project-detail.component').then(m => m.ProjectDetailComponent), canActivate: [authGuard] },
  // Monitoring is in place on the project page; the old pages redirect to their view.
  { path: 'projects/:id/observability', pathMatch: 'full', redirectTo: toMonitoring((qp) => viewForObsTab(qp['tab'])) }, // #48
  { path: 'projects/:id/errors', pathMatch: 'full', redirectTo: toMonitoring('errors') }, // #41
  { path: 'projects/:id/replays', pathMatch: 'full', redirectTo: toMonitoring('users') }, // #40
  { path: 'projects/:id/heatmaps', pathMatch: 'full', redirectTo: toMonitoring('users') },
  { path: 'projects/:id/synthetics', pathMatch: 'full', redirectTo: toMonitoring('uptime') }, // #42
  { path: 'projects/:id/status', pathMatch: 'full', redirectTo: toMonitoring('uptime') }, // #46
  { path: 'projects/:id/replays/:sessionId', loadComponent: () => import('./pages/replays/replay-player.component').then(m => m.ReplayPlayerComponent), canActivate: [authGuard] }, // #40 player stays a page
  // Fleet monitoring (sidebar "Monitoring"); the global Errors page folded into it.
  { path: 'observability', loadComponent: () => import('./pages/observability/obs-fleet.component').then(m => m.ObsFleetComponent), canActivate: [authGuard] }, // #48
  { path: 'errors', pathMatch: 'full', redirectTo: '/observability' },
  { path: 'status/:slug', loadComponent: () => import('./pages/status-page/public-status.component').then(m => m.PublicStatusComponent) }, // #46 public, no auth
  { path: 'deployments', loadComponent: () => import('./pages/deployments/deployments.component').then(m => m.DeploymentsComponent), canActivate: [authGuard] },
  { path: 'services', loadComponent: () => import('./pages/services/services.component').then(m => m.ServicesComponent), canActivate: [authGuard] },
  { path: 'metrics', loadComponent: () => import('./pages/metrics/metrics.component').then(m => m.MetricsComponent), canActivate: [authGuard] },
  { path: 'alerts', loadComponent: () => import('./pages/alerts/alerts.component').then(m => m.AlertsComponent), canActivate: [authGuard] },
  { path: 'alerting', loadComponent: () => import('./pages/alerting/alerting.component').then(m => m.AlertingComponent), canActivate: [authGuard] }, // #43
  { path: 'logs', loadComponent: () => import('./pages/logs/logs.component').then(m => m.LogsComponent), canActivate: [authGuard] },
  { path: 'config', loadComponent: () => import('./pages/config/config.component').then(m => m.ConfigComponent), canActivate: [authGuard] },
  { path: 'storage', loadComponent: () => import('./pages/storage/storage.component').then(m => m.StorageComponent), canActivate: [authGuard] },
  { path: 'db-connections', loadComponent: () => import('./pages/db-connections/db-connections.component').then(m => m.DbConnectionsComponent), canActivate: [authGuard] },
  { path: 'bootstrap', loadComponent: () => import('./pages/bootstrap/bootstrap.component').then(m => m.BootstrapComponent), canActivate: [authGuard] },
  { path: 'cicd', loadComponent: () => import('./pages/cicd/cicd.component').then(m => m.CicdComponent), canActivate: [authGuard] },

  { path: 'preview-urls', loadComponent: () => import('./pages/preview-urls/preview-urls.component').then(m => m.PreviewUrlsComponent), canActivate: [authGuard] },
  { path: 'clickup', loadComponent: () => import('./pages/clickup/clickup.component').then(m => m.ClickupComponent), canActivate: [authGuard] },
  { path: 'infrastructure', loadComponent: () => import('./pages/infrastructure/infrastructure.component').then(m => m.InfrastructureComponent), canActivate: [authGuard] },
  { path: 'audit-logs', loadComponent: () => import('./pages/audit-logs/audit-logs.component').then(m => m.AuditLogsComponent), canActivate: [authGuard] },
  { path: 'users', loadComponent: () => import('./pages/users/users.component').then(m => m.UsersComponent), canActivate: [authGuard] },
  { path: 'playground', loadComponent: () => import('./pages/playground/playground.component').then(m => m.PlaygroundComponent), canActivate: [authGuard] },
  { path: 'settings', loadComponent: () => import('./pages/settings/settings.component').then(m => m.SettingsComponent), canActivate: [authGuard] },
  { path: 'profile', loadComponent: () => import('./pages/profile/profile.component').then(m => m.ProfileComponent), canActivate: [authGuard] },

  { path: '**', redirectTo: '' }
];
