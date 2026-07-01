import { Component } from '@angular/core';
import { RouterOutlet, NavigationEnd, Router } from '@angular/router';
import { SidebarComponent } from './layout/sidebar/sidebar.component';
import { HeaderComponent } from './layout/header/header.component';
import { CommonModule } from '@angular/common';
import { filter } from 'rxjs';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, SidebarComponent, HeaderComponent, CommonModule],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css'
})
export class AppComponent {
  pageTitle = 'Dashboard';
  isLoginPage = false;
  isLandingPage = false;
  isSidebarCollapsed = false;

  private titles: Record<string, string> = {
    'dashboard': 'Dashboard',
    'projects': 'Projects',
    'project-detail': 'Project Detail',
    'deployments': 'Deployments',
    'services': 'Services',
    'metrics': 'Metrics',
    'alerts': 'Alerts',
    'logs': 'Logs',
    'config': 'Configuration',
    'storage': 'Storage',
    'db-connections': 'DB Connections',
    'bootstrap': 'Bootstrap',
    'cicd': 'CI/CD Templates',
    'preview-urls': 'Preview URLs',
    'clickup': 'ClickUp Integration',
    'infrastructure': 'Infrastructure',
    'audit-logs': 'Audit Logs',
    'users': 'User Management',
    'playground': 'API Documentation & Playground'
  };

  constructor(router: Router) {
    router.events.pipe(filter(e => e instanceof NavigationEnd)).subscribe(() => {
      const segment = router.url.split('/')[1]?.split('?')[0] || 'dashboard';
      this.isLoginPage = segment === 'login' || segment === 'oauth';
      this.isLandingPage = segment === 'landing';
      this.pageTitle = this.titles[segment] || 'Platform';
    });
  }
}
