import { inject } from '@angular/core';
import { Params, RedirectFunction, Router, Routes } from '@angular/router';
import { DashboardComponent } from './pages/dashboard/dashboard.component';
import { ProjectsComponent } from './pages/projects/projects.component';
import { ProjectDetailComponent } from './pages/project-detail/project-detail.component';
import { DeploymentsComponent } from './pages/deployments/deployments.component';
import { ServicesComponent } from './pages/services/services.component';
import { MetricsComponent } from './pages/metrics/metrics.component';
import { LogsComponent } from './pages/logs/logs.component';
import { ConfigComponent } from './pages/config/config.component';
import { StorageComponent } from './pages/storage/storage.component';
import { BootstrapComponent } from './pages/bootstrap/bootstrap.component';
import { CicdComponent } from './pages/cicd/cicd.component';
import { AlertsComponent } from './pages/alerts/alerts.component';
import { AlertingComponent } from './pages/alerting/alerting.component';
import { DbConnectionsComponent } from './pages/db-connections/db-connections.component';

import { LoginComponent } from './pages/login/login.component';
import { UsersComponent } from './pages/users/users.component';
import { PreviewUrlsComponent } from './pages/preview-urls/preview-urls.component';
import { ClickupComponent } from './pages/clickup/clickup.component';
import { InfrastructureComponent } from './pages/infrastructure/infrastructure.component';
import { AuditLogsComponent } from './pages/audit-logs/audit-logs.component';
import { PlaygroundComponent } from './pages/playground/playground.component';
import { SettingsComponent } from './pages/settings/settings.component';
import { LandingComponent } from './pages/landing/landing.component';
import { AboutComponent } from './pages/about/about.component';
import { OauthAuthorizeComponent } from './pages/oauth-authorize/oauth-authorize.component';
import { IframeViewComponent } from './pages/iframe-view/iframe-view.component';
import { DocsComponent } from './pages/docs/docs.component';
import { ProfileComponent } from './pages/profile/profile.component';
import { MfaEnrollComponent } from './pages/mfa-enroll/mfa-enroll.component';
import { PublicStatusComponent } from './pages/status-page/public-status.component';
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

  // Marketing site only (platform.pratyushes.dev)
  { path: 'landing', canActivate: [marketingOnlyGuard, legacyLandingGuard], children: [] },
  { path: 'about', component: AboutComponent, canActivate: [marketingOnlyGuard], title: 'About Cairn' },
  { matcher: docsMatcher, component: DocsComponent, canActivate: [docsGuard] },

  // App / server hosts only
  { path: 'login', component: LoginComponent, canActivate: [appHostGuard] },
  { path: 'oauth/authorize', component: OauthAuthorizeComponent, canActivate: [appHostGuard] },
  // Forced MFA enrolment for roles in mfa.requiredRoles (#24); the component checks the session.
  { path: 'mfa/enroll', component: MfaEnrollComponent, canActivate: [appHostGuard] },

  { path: 'dashboard', component: DashboardComponent, canActivate: [authGuard] },
  // ArgoCD is full-page at /argocd/ (ingress) — leave the SPA rather than iframe.
  {
    path: 'argocd',
    canActivate: [authGuard, () => {
      window.location.replace('/argocd/');
      return false;
    }],
    children: [],
  },
  { path: 'grafana', component: IframeViewComponent, canActivate: [authGuard], data: { url: '/grafana/' } },
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

  { path: 'projects', component: ProjectsComponent, canActivate: [authGuard] },
  { path: 'projects/:id', component: ProjectDetailComponent, canActivate: [authGuard] },
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
  { path: 'status/:slug', component: PublicStatusComponent }, // #46 public, no auth
  { path: 'deployments', component: DeploymentsComponent, canActivate: [authGuard] },
  { path: 'services', component: ServicesComponent, canActivate: [authGuard] },
  { path: 'metrics', component: MetricsComponent, canActivate: [authGuard] },
  { path: 'alerts', component: AlertsComponent, canActivate: [authGuard] },
  { path: 'alerting', component: AlertingComponent, canActivate: [authGuard] }, // #43
  { path: 'logs', component: LogsComponent, canActivate: [authGuard] },
  { path: 'config', component: ConfigComponent, canActivate: [authGuard] },
  { path: 'storage', component: StorageComponent, canActivate: [authGuard] },
  { path: 'db-connections', component: DbConnectionsComponent, canActivate: [authGuard] },
  { path: 'bootstrap', component: BootstrapComponent, canActivate: [authGuard] },
  { path: 'cicd', component: CicdComponent, canActivate: [authGuard] },

  { path: 'preview-urls', component: PreviewUrlsComponent, canActivate: [authGuard] },
  { path: 'clickup', component: ClickupComponent, canActivate: [authGuard] },
  { path: 'infrastructure', component: InfrastructureComponent, canActivate: [authGuard] },
  { path: 'audit-logs', component: AuditLogsComponent, canActivate: [authGuard] },
  { path: 'users', component: UsersComponent, canActivate: [authGuard] },
  { path: 'playground', component: PlaygroundComponent, canActivate: [authGuard] },
  { path: 'settings', component: SettingsComponent, canActivate: [authGuard] },
  { path: 'profile', component: ProfileComponent, canActivate: [authGuard] },

  { path: '**', redirectTo: '' }
];
