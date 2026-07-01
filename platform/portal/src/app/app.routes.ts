import { Routes } from '@angular/router';
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

// New Components
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

import { authGuard } from './guards/auth.guard';

export const routes: Routes = [
  { path: '', redirectTo: '/landing', pathMatch: 'full' },
  { path: 'landing', component: LandingComponent },
  { path: 'login', component: LoginComponent },
  { path: 'oauth/authorize', component: OauthAuthorizeComponent },
  
  // Guarded Routes
  { path: 'dashboard', component: DashboardComponent, canActivate: [authGuard] },
  { path: 'argocd', component: IframeViewComponent, canActivate: [authGuard], data: { url: '/argocd/' } },
  { path: 'grafana', component: IframeViewComponent, canActivate: [authGuard], data: { url: '/grafana/' } },
  { path: 'portainer', component: IframeViewComponent, canActivate: [authGuard], data: { url: '/portainer/' } },

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
  
  // Newly Implemented Routes
  { path: 'preview-urls', component: PreviewUrlsComponent, canActivate: [authGuard] },
  { path: 'clickup', component: ClickupComponent, canActivate: [authGuard] },
  { path: 'infrastructure', component: InfrastructureComponent, canActivate: [authGuard] },
  { path: 'audit-logs', component: AuditLogsComponent, canActivate: [authGuard] },
  { path: 'users', component: UsersComponent, canActivate: [authGuard] },
  { path: 'playground', component: PlaygroundComponent, canActivate: [authGuard] },
  { path: 'settings', component: SettingsComponent, canActivate: [authGuard] },
  { path: 'docs', component: DocsComponent },
  { path: 'docs/:section', component: DocsComponent },
  { path: 'docs/:section/:page', component: DocsComponent },
  
  // Wildcard redirect
  { path: '**', redirectTo: '/dashboard' }
];
