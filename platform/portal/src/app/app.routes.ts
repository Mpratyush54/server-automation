import { inject } from '@angular/core';
import { Router, Routes, CanActivateFn } from '@angular/router';
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
import { OauthAuthorizeComponent } from './pages/oauth-authorize/oauth-authorize.component';
import { IframeViewComponent } from './pages/iframe-view/iframe-view.component';
import { DocsComponent } from './pages/docs/docs.component';
import { ProfileComponent } from './pages/profile/profile.component';

import { authGuard } from './guards/auth.guard';
import { appHostGuard, marketingOnlyGuard, isPublicMarketingHost } from './guards/public-domain.guard';
import { AuthService } from './services/auth.service';

/** Marketing host → landing. App host → dashboard if logged in, otherwise login. */
const homeGuard: CanActivateFn = () => {
  const router = inject(Router);
  if (isPublicMarketingHost()) {
    router.navigateByUrl('/landing');
    return false;
  }
  const auth = inject(AuthService);
  router.navigateByUrl(auth.isAuthenticated() ? '/dashboard' : '/login');
  return false;
};

export const routes: Routes = [
  { path: '', pathMatch: 'full', canActivate: [homeGuard], children: [] },

  // Marketing site only (platform.pratyushes.dev)
  { path: 'landing', component: LandingComponent, canActivate: [marketingOnlyGuard] },
  { path: 'docs', component: DocsComponent, canActivate: [marketingOnlyGuard] },
  { path: 'docs/:section', component: DocsComponent, canActivate: [marketingOnlyGuard] },
  { path: 'docs/:section/:page', component: DocsComponent, canActivate: [marketingOnlyGuard] },

  // App / server hosts only
  { path: 'login', component: LoginComponent, canActivate: [appHostGuard] },
  { path: 'oauth/authorize', component: OauthAuthorizeComponent, canActivate: [appHostGuard] },

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
  { path: 'deployments', component: DeploymentsComponent, canActivate: [authGuard] },
  { path: 'services', component: ServicesComponent, canActivate: [authGuard] },
  { path: 'metrics', component: MetricsComponent, canActivate: [authGuard] },
  { path: 'alerts', component: AlertsComponent, canActivate: [authGuard] },
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

  { path: '**', canActivate: [homeGuard], children: [] }
];
