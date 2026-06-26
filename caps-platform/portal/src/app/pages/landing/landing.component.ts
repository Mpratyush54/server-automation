import { Component, OnInit, OnDestroy, Inject, PLATFORM_ID } from '@angular/core';
import { CommonModule, isPlatformBrowser } from '@angular/common';
import { RouterModule } from '@angular/router';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';

@Component({
  selector: 'app-landing',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './landing.component.html',
  styleUrl: './landing.component.css'
})
export class LandingComponent implements OnInit, OnDestroy {
  activeSection = 'overview';
  private observer: IntersectionObserver | null = null;

  sections = [
    { id: 'overview', label: 'Overview' },
    { id: 'setup', label: 'Setup Guide' },
    { id: 'auth', label: 'Authentication' },
    { id: 'api', label: 'API Reference' },
    { id: 'sdk', label: 'SDK Usage' },
    { id: 'rbac', label: 'Roles & Permissions' },
    { id: 'webhooks', label: 'Webhooks' },
  ];

  codeExamples: Record<string, SafeHtml> = {};

  constructor(
    private sanitizer: DomSanitizer,
    @Inject(PLATFORM_ID) private platformId: Object
  ) {
    const esc = (s: string) => s.replace(/{/g, '&#123;').replace(/}/g, '&#125;');
    const raw: Record<string, string> = {};

    raw['sdk-token'] = `sdk-{projectId}:{secret}`;
    raw['node-init'] = `const caps = require('@caps/sdk-node');

await caps.init({
  projectName: 'my-app',
  platformUrl: 'http://your-caps-server',
  environmentName: 'production',
});

// Attaches to Express — zero-overhead tracking
app.use(caps.expressMiddleware());
caps.captureConsole(); // forward all console.*

// Winston transport
const transport = caps.winstonTransport();
logger.add(transport);

// Pino destination
const dest = caps.pinoTransport();`;

    raw['python-init'] = `from caps_sdk import CapsClient

caps = CapsClient()
caps.init(
    project_name="my-app",
    platform_url="http://your-caps-server:3000",
    environment_name="production",
)

# Postgres connection
pg = caps.postgres(host="localhost", port=5432, database="mydb")
await pg.connect()
await pg.execute("SELECT * FROM users")`;

    raw['react-init'] = `import { CapsProvider, ErrorBoundary, BugReporterWidget } from '@caps/sdk-react';

<CapsProvider config={{ apiBase: 'http://localhost:3000', token: 'sdk-token', projectId: 'my-app' }}>
  <ErrorBoundary config={{ ... }}>
    <App />
  </ErrorBoundary>
  <BugReporterWidget config={{ ... }} />
</CapsProvider>`;

    raw['angular-init'] = `// app.module.ts
import { CapsModule } from '@caps/sdk-angular';

&#64;NgModule({
  imports: [
    CapsModule.forRoot({
      apiBase: 'http://localhost:3000',
      token: 'sdk-token',
      projectId: 'my-app',
    }),
  ],
})
export class AppModule {}`;

    raw['env-vars'] = `# Database
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_USER=caps
POSTGRES_PASSWORD=caps
POSTGRES_DB=caps_platform

# MongoDB
MONGODB_URI=mongodb://localhost:27017/caps_platform

# Auth
JWT_SECRET=your-secret-key

# Integrations (optional)
GITLAB_API_URL=https://gitlab.com/api/v4
GITLAB_TOKEN=glpat-xxxxx
CLICKUP_API_TOKEN=pkxxxxx
GITHUB_TOKEN=ghp_xxxxx
GITHUB_WEBHOOK_SECRET=your-webhook-secret
GITLAB_WEBHOOK_SECRET=your-webhook-secret

# Portal
PORTAL_URL=http://localhost:4200`;

    raw['clone'] = `git clone https://github.com/your-org/caps-platform.git
cd caps-platform`;

    raw['api-install'] = `cd api
npm install
npm run dev`;

    raw['portal-install'] = `cd portal
npm install
ng serve`;

    raw['seed'] = `curl http://localhost:3000/api/users/init-demo`;

    raw['login-curl'] = `curl -X POST http://localhost:3000/api/auth/login \\
  -H "Content-Type: application/json" \\
  -d '{"email": "admin@caps.io"}'`;

    raw['login-response'] = `{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "user": {
    "id": "00000000-0000-0000-0000-000000000001",
    "email": "admin@caps.io",
    "name": "Admin",
    "role": "admin"
  }
}`;

    raw['create-role'] = `POST /api/roles
Content-Type: application/json
Authorization: Bearer <token>

{
  "name": "database-admin",
  "description": "Can manage databases and backups only",
  "permissions": [
    "databases.provision",
    "databases.backup",
    "databases.restore",
    "databases.read"
  ]
}`;

    raw['assign-role'] = `PATCH /api/users/:userId/role
Content-Type: application/json
Authorization: Bearer <token>

{
  "roleId": "role-uuid-here"
}`;

    raw['login-request'] = `POST /api/auth/login
Content-Type: application/json

{"email": "admin@caps.io"}`;

    raw['arch'] = `caps-platform/
  ├── api/              # Express + TypeORM (PostgreSQL) + Mongoose (MongoDB)
  ├── portal/           # Angular 19 admin dashboard
  ├── caps-sdk-node/    # Node.js SDK (auto-registration, metrics, logging)
  ├── caps-sdk-python/  # Python SDK
  ├── caps-sdk-react/   # React/Next.js SDK (interceptor, error boundary, bug reporter)
  ├── caps-sdk-angular/ # Angular SDK (HTTP interceptor, error handler)
  └── caps-bootstrap/   # Cluster bootstrap script (k3s + Helm charts)`;

    raw['register-webhook'] = `POST /api/cicd/register-webhook/:projectId
Authorization: Bearer <token>

# Auto-registers the webhook on GitHub/GitLab
# using the project's repositoryUrl and configured API token`;

    raw['wh-gh'] = `GITHUB_WEBHOOK_SECRET=your-secret    # HMAC key for GitHub signature verification
GITLAB_WEBHOOK_SECRET=your-secret    # Token for GitLab webhook verification
GITHUB_TOKEN=ghp_xxxxx               # For auto-registering webhooks on GitHub
GITLAB_TOKEN=glpat-xxxxx             # For auto-registering webhooks on GitLab`;

    for (const [key, val] of Object.entries(raw)) {
      this.codeExamples[key] = this.sanitizer.bypassSecurityTrustHtml(esc(val));
    }
  }

  ngOnInit() {
    if (isPlatformBrowser(this.platformId)) {
      // Small timeout to let elements render before setting up scroll spy
      setTimeout(() => this.setupScrollSpy(), 100);
    }
  }

  ngOnDestroy() {
    if (this.observer) {
      this.observer.disconnect();
    }
  }

  setupScrollSpy() {
    const options = {
      root: null, // relative to viewport
      rootMargin: '-10% 0px -75% 0px', // triggers when section is near the top
      threshold: 0
    };

    this.observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          this.activeSection = entry.target.id;
        }
      });
    }, options);

    this.sections.forEach((section) => {
      const el = document.getElementById(section.id);
      if (el && this.observer) {
        this.observer.observe(el);
      }
    });
  }

  setActive(id: string) {
    this.activeSection = id;
    const el = document.getElementById(id);
    if (el) {
      // Disconnect observer temporarily to prevent jumping during click scroll
      if (this.observer) this.observer.disconnect();

      el.scrollIntoView({ behavior: 'smooth', block: 'start' });

      // Reconnect observer after smooth scroll completes
      setTimeout(() => {
        if (isPlatformBrowser(this.platformId)) {
          this.setupScrollSpy();
        }
      }, 800);
    }
  }
}
