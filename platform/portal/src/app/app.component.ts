import { Component, OnDestroy } from '@angular/core';
import { RouterOutlet, NavigationEnd, Router } from '@angular/router';
import { SidebarComponent } from './layout/sidebar/sidebar.component';
import { HeaderComponent } from './layout/header/header.component';
import { StepUpModalComponent } from './shared/step-up-modal.component';

import { filter } from 'rxjs';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, SidebarComponent, HeaderComponent, StepUpModalComponent],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css'
})
export class AppComponent implements OnDestroy {
  pageTitle = 'Dashboard';
  isLoginPage = false;
  isLandingPage = false;
  isDocsPage = false;
  /** Public status page (#46) — no app chrome. */
  isPublicStatusPage = false;
  isSidebarCollapsed = false;
  /** Below md (768px) the sidebar is an off-canvas drawer. */
  isMobile = false;
  /** Drawer visibility on mobile. */
  mobileNavOpen = false;

  private mqMobile?: MediaQueryList;
  private mqDesktop?: MediaQueryList;
  private readonly onViewportChange = () => this.applyViewport();

  private titles: Record<string, string> = {
    'dashboard': 'Dashboard',
    'projects': 'Projects',
    'project-detail': 'Project Detail',
    'deployments': 'Deployments',
    'services': 'Services',
    'metrics': 'Metrics',
    'alerts': 'Alerts',
    'alerting': 'Alerting',
    'errors': 'Errors',
    'observability': 'Observability',
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
    'playground': 'API Documentation & Playground',
    'settings': 'Settings',
    'profile': 'Profile'
  };

  /** Titles for project sub-pages (/projects/:id/<page>). */
  private projectPageTitles: Record<string, string> = {
    'errors': 'Errors',
    'synthetics': 'Synthetics',
    'status': 'Status page',
    'heatmaps': 'Heatmaps',
    'observability': 'Observability',
    'replays': 'Session replays',
  };

  constructor(router: Router) {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      this.mqMobile = window.matchMedia('(max-width: 767.98px)');
      this.mqDesktop = window.matchMedia('(min-width: 1024px)');
      this.mqMobile.addEventListener?.('change', this.onViewportChange);
      this.mqDesktop.addEventListener?.('change', this.onViewportChange);
      this.applyViewport();
    }
    router.events.pipe(filter(e => e instanceof NavigationEnd)).subscribe(() => {
      this.mobileNavOpen = false;
      const parts = router.url.split(/[?#]/)[0].split('/');
      const segment = parts[1] || '';
      this.isLoginPage = segment === 'login' || segment === 'oauth' || segment === 'mfa';
      this.isLandingPage = segment === '' || segment === 'landing';
      this.isDocsPage = segment === 'docs';
      this.isPublicStatusPage = segment === 'status';
      this.pageTitle = (segment === 'projects' && parts[3] && this.projectPageTitles[parts[3]])
        || this.titles[segment] || 'Platform';
    });
  }

  /**
   * Derive the shell layout from the viewport: drawer below md, collapsed rail
   * between md and lg, expanded sidebar from lg up.
   */
  applyViewport(width?: number) {
    const w = width ?? (typeof window !== 'undefined' ? window.innerWidth : 1440);
    this.isMobile = w < 768;
    this.mobileNavOpen = false;
    this.isSidebarCollapsed = !this.isMobile && w < 1024;
  }

  /** Header menu button / sidebar chevron. */
  toggleSidebar() {
    if (this.isMobile) this.mobileNavOpen = !this.mobileNavOpen;
    else this.isSidebarCollapsed = !this.isSidebarCollapsed;
  }

  closeMobileNav() {
    this.mobileNavOpen = false;
  }

  ngOnDestroy() {
    this.mqMobile?.removeEventListener?.('change', this.onViewportChange);
    this.mqDesktop?.removeEventListener?.('change', this.onViewportChange);
  }
}
